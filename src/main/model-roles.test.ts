import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store';
import { Runner } from './runner';
import type { ChatInput, LocalProviders } from './providers';
import type { Session } from '../shared/types';

const roots: string[] = [];
const stores: Store[] = [];
const profile = { provider: 'ollama' as const, connectionId: 'server', model: 'main', contextLimit: 32768, toolVerified: true };
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mercury-roles-')); roots.push(root);
  const filename = path.join(root, 'state.sqlite');
  const store = new Store(filename); stores.push(store);
  store.saveSettings({ connections: [{ id: 'server', provider: 'ollama', label: 'Server', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: { ...profile, model: 'planner' }, subagentModel: { ...profile, model: 'small' } });
  store.saveProject({ id: 'project', name: 'Project', path: root });
  const session: Session = { id: 'session', projectId: 'project', objective: 'Inspect note', status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), events: [], plan: null, changes: [], command: null, assignments: null };
  store.saveSession(session);
  return { root, filename, store, session };
}
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const plan = { objective: 'Inspect note', assumptions: [], steps: [{ title: 'Inspect', details: 'Read note', checks: ['Read file'] }], blockers: [] };

it.each([true, false])('migrates legacy settings and pinned assignments, preferring the default when present: %s', hasDefault => {
  const { filename, store, session } = fixture();
  const db = new DatabaseSync(filename);
  db.prepare("UPDATE settings SET data = ? WHERE key = 'app'").run(JSON.stringify({ connections: store.settings().connections, defaultModel: hasDefault ? profile : null, overrides: { coder: { ...profile, model: 'old-coder' }, planner: { ...profile, model: 'old-planner' }, critic: profile, synthesizer: profile } }));
  db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify({ ...session, status: 'interrupted', plan: { content: plan, revision: 1, approved: true, createdAt: 1 }, assignments: { planner: { ...profile, model: 'pinned-planner' }, coder: { ...profile, model: 'pinned-coder', endpoint: 'http://127.0.0.1:9999' } }, events: [{ id: 'event', kind: 'message', role: 'critic', text: 'Historic review', at: 1 }] }), session.id);
  db.close();
  expect(store.settings().mainModel?.model).toBe(hasDefault ? 'main' : 'old-coder');
  expect(store.settings().plannerModel?.model).toBe('old-planner');
  expect(store.settings().subagentModel).toBeNull();
  expect(store.session(session.id).assignments?.main.endpoint).toBe('http://127.0.0.1:9999');
  expect(store.session(session.id).assignments?.subagent.model).toBe('pinned-coder');
  expect(store.sessions()[0].events[0].role).toBe('critic');
  store.saveSettings(store.settings());
  const saved = new DatabaseSync(filename);
  expect(JSON.parse((saved.prepare("SELECT data FROM settings WHERE key = 'app'").get() as any).data)).not.toHaveProperty('overrides');
  saved.close();
});

it('plans once, pins all roles, delegates project reads, and leaves the final actions to Main', async () => {
  const { root, store, session } = fixture();
  writeFileSync(path.join(root, 'note.txt'), 'Evidence');
  const requests: ChatInput[] = [];
  const providers = { chat: async (input: ChatInput) => {
    requests.push(input);
    input.onRoutingNotice?.(`Connection for ${input.profile.model}; API charges apply.`);
    if (input.profile.model === 'planner') return { text: JSON.stringify(plan), tools: [] };
    if (input.profile.model === 'small') {
      if (input.messages.length === 2) return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { path: 'note.txt' } }] };
      expect(JSON.stringify(input.messages)).toContain('Evidence');
      return { text: 'Found evidence in note.txt', tools: [] };
    }
    if (input.messages.length === 2) return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Inspect note', context: 'Read note.txt' } }] };
    expect(JSON.stringify(input.messages)).toContain('Found evidence');
    return { text: '', tools: [{ id: 'finish', name: 'finish', arguments: { summary: 'Reviewed findings', verification: 'Read note.txt' } }] };
  }, probe: async () => true } as unknown as LocalProviders;
  const runner = new Runner(store, providers, () => {});
  await runner.plan(session.id);
  expect(requests).toHaveLength(1);
  store.saveSettings({ ...store.settings(), mainModel: { ...profile, model: 'changed-after-planning' }, subagentModel: null });
  await runner.approve(session.id, 1);
  expect(requests.map(request => request.profile.model)).toEqual(['planner', 'main', 'small', 'small', 'main']);
  expect(store.session(session.id).status).toBe('completed');
  expect(store.session(session.id).events.some(event => event.role === 'subagent' && event.text === 'Found evidence in note.txt')).toBe(true);
  for (const role of ['planner', 'main', 'subagent']) expect(store.session(session.id).events.some(event => event.role === role && event.kind === 'status' && event.text.includes('API charges apply'))).toBe(true);
  expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('Evidence');
});

it('repairs one malformed Planner response and preserves blocking questions', async () => {
  const { store, session } = fixture(); let calls = 0;
  const providers = { chat: async () => ({ text: ++calls === 1 ? 'bad JSON' : JSON.stringify({ ...plan, blockers: ['Which target?'] }), tools: [] }) } as unknown as LocalProviders;
  await new Runner(store, providers, () => {}).plan(session.id);
  expect(calls).toBe(2);
  expect(store.session(session.id).status).toBe('awaiting_input');
});

it('returns delegation failures to Main without granting write tools or changing provider', async () => {
  const { store, session } = fixture(); let mainCalls = 0;
  const providers = { chat: async (input: ChatInput) => {
    if (input.profile.model === 'planner') return { text: JSON.stringify(plan), tools: [] };
    if (input.profile.model === 'small') return { text: '', tools: [{ id: 'bad', name: 'edit_file', arguments: {} }] };
    if (++mainCalls === 1) return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Inspect', context: '' } }] };
    expect(JSON.stringify(input.messages)).toContain('Subagent cannot use edit_file');
    return { text: '', tools: [{ id: 'finish', name: 'finish', arguments: { summary: 'Handled failure', verification: 'No changes' } }] };
  } } as unknown as LocalProviders;
  const runner = new Runner(store, providers, () => {});
  await runner.plan(session.id); await runner.approve(session.id, 1);
  expect(store.session(session.id).changes).toHaveLength(0);
  expect(store.session(session.id).status).toBe('completed');
});
