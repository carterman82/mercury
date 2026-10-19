import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatInput, ChatResult } from './providers';
import type { Session } from '../shared/types';
import { hash, Workspace } from './workspace';
import { Store } from './store';
import { Runner } from './runner';
import { LocalProviders } from './providers';
import { CommandGate } from './commands';
import { DatabaseSync } from 'node:sqlite';

const directories: string[] = [];
const fixture = () => { const root = mkdtempSync(path.join(os.tmpdir(), 'local-plan-agent-')); directories.push(root); return root; };
afterEach(() => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('workspace boundaries', () => {
  it('rejects conflicting writes and paths that escape the project', async () => {
    const root = fixture();
    writeFileSync(path.join(root, 'note.txt'), 'user work');
    const workspace = new Workspace(root);
    await expect(workspace.edit('note.txt', hash('old work'), 'replacement')).rejects.toThrow(/changed/);
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('user work');
    await expect(workspace.read('../outside.txt')).rejects.toThrow(/Invalid/);
    await expect(workspace.edit('.git/config', null, 'bad')).rejects.toThrow(/Invalid/);
  });
  it('creates a file only when absent and reports a new-file collision', async () => {
    const root = fixture();
    const workspace = new Workspace(root);
    await workspace.edit('nested/new.txt', null, 'created');
    expect(readFileSync(path.join(root, 'nested/new.txt'), 'utf8')).toBe('created');
    await expect(workspace.edit('nested/new.txt', null, 'overwrite')).rejects.toThrow(/changed/);
  });
});

describe('approval and recovery', () => {
  it('invalidates approval when the plan changes and completes a fixture change', async () => {
    const root = fixture();
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath);
    writeFileSync(path.join(projectPath, 'note.txt'), 'old');
    const store = new Store(path.join(root, 'state.sqlite'));
    const project = { id: randomUUID(), path: projectPath, name: 'project' };
    store.saveProject(project);
    const profile = { provider: 'ollama' as const, model: 'fake', contextLimit: 8192, toolVerified: true };
    store.saveSettings({ connections: [{ id: 'local-ollama', provider: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434' }], defaultModel: { ...profile, connectionId: 'local-ollama' }, overrides: {} });
    const now = Date.now();
    const session: Session = { id: randomUUID(), projectId: project.id, objective: 'Update note', status: 'draft', createdAt: now, updatedAt: now, events: [], plan: null, changes: [], command: null, assignments: null };
    store.saveSession(session);
    let coderTurn = 0;
    const fake = {
      chat: async ({ messages }: ChatInput): Promise<ChatResult> => {
        const role = String((messages[0] as any).content);
        if (role.includes('synthesizer')) return { text: JSON.stringify({ objective: 'Update note', assumptions: [], steps: [{ title: 'Update file', details: 'Replace old with new.', checks: ['Inspect file'] }], blockers: [] }), tools: [] };
        if (role.includes('coder')) {
          coderTurn++;
          return coderTurn === 1
            ? { text: '', tools: [{ id: 'edit-1', name: 'edit_file', arguments: { path: 'note.txt', expectedHash: hash('old'), content: 'new' } }] }
            : { text: '', tools: [{ id: 'finish-1', name: 'finish', arguments: { summary: 'Updated note.', verification: 'File read checked.' } }] };
        }
        return { text: 'Inspect and update note.txt.', tools: [] };
      },
      probe: async () => true,
    } as unknown as LocalProviders;
    const runner = new Runner(store, fake, () => {});
    await runner.plan(session.id);
    expect(store.session(session.id).status).toBe('awaiting_review');
    runner.savePlan(session.id, { ...store.session(session.id).plan!.content, assumptions: ['The file is text.'] });
    await expect(runner.approve(session.id, 1)).rejects.toThrow(/changed/);
    await runner.approve(session.id, 2);
    expect(store.session(session.id).status).toBe('completed');
    expect(store.session(session.id).changes).toHaveLength(1);
    expect(readFileSync(path.join(projectPath, 'note.txt'), 'utf8')).toBe('new');
    store.close();
  });
  it('marks an unfinished run interrupted on restart without replaying its tools', () => {
    const root = fixture();
    const filename = path.join(root, 'state.sqlite');
    const store = new Store(filename);
    const now = Date.now();
    const session: Session = { id: randomUUID(), projectId: randomUUID(), objective: 'Test', status: 'implementing', createdAt: now, updatedAt: now, events: [], plan: null, changes: [], command: null, assignments: null };
    store.saveSession(session);
    store.close();
    const restarted = new Store(filename);
    expect(restarted.session(session.id).status).toBe('interrupted');
    restarted.close();
  });
  it('does not run a denied command and remembers only an exact approved command', async () => {
    const gate = new CommandGate(() => {});
    const signal = new AbortController().signal;
    const first = gate.ask('npm test', 'C:\\project', signal);
    const pending = (gate as any).pending.request.id;
    gate.answer(pending, false, false);
    expect(await first).toBe(false);
    const second = gate.ask('npm test', 'C:\\project', signal);
    gate.answer((gate as any).pending.request.id, true, true);
    expect(await second).toBe(true);
    expect(await gate.ask('npm test', 'C:\\project', signal)).toBe(true);
    const different = gate.ask('npm run build', 'C:\\project', signal);
    gate.answer((gate as any).pending.request.id, false, false);
    expect(await different).toBe(false);
  });
});

describe('provider streams', () => {
  it.each(['ollama', 'lmstudio'] as const)('separates streamed %s reasoning from the answer', async provider => {
    const chunks = provider === 'ollama'
      ? [{ message: { thinking: 'Check ' } }, { message: { thinking: 'the arithmetic.' } }, { message: { content: '**42**' }, done: true }].map(item => JSON.stringify(item) + '\n').join('')
      : [{ choices: [{ delta: { reasoning_content: 'Check ' } }] }, { choices: [{ delta: { reasoning_content: 'the arithmetic.' } }] }, { choices: [{ delta: { content: '**42**' } }] }].map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n';
    const bytes = new TextEncoder().encode(chunks);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11)); controller.close(); } }))));
    const providers = new LocalProviders(() => ({ connections: [{ id: 'test', provider, label: 'Test', url: 'http://127.0.0.1:1234' }], defaultModel: null, overrides: {} }));
    const thoughts: string[] = [];
    const answer: string[] = [];
    const result = await providers.chat({ profile: { provider, connectionId: 'test', model: 'test', contextLimit: 8192 }, messages: [], signal: new AbortController().signal, onReasoning: part => thoughts.push(part), onText: part => answer.push(part) });
    expect(thoughts.join('')).toBe('Check the arithmetic.');
    expect(answer.join('')).toBe('**42**');
    expect(result.reasoning).toBe('Check the arithmetic.');
    expect(result.text).toBe('**42**');
  });
  it('discovers separate LM Studio models and excludes embeddings', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [
      { type: 'llm', key: 'qwen-one', display_name: 'Qwen One', loaded_instances: [{ id: 'loaded' }], max_context_length: 32768, capabilities: { trained_for_tool_use: true } },
      { type: 'embedding', key: 'embed', loaded_instances: [] },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const providers = new LocalProviders(() => ({ connections: [], defaultModel: null, overrides: {} }));
    const connection = { id: 'shared', provider: 'lmstudio' as const, label: 'Shared Mac', url: 'http://100.80.53.57:1234' };
    const models = await providers.discover(connection);
    expect(models).toEqual([{ provider: 'lmstudio', connectionId: 'shared', connectionLabel: 'Shared Mac', id: 'qwen-one', label: 'Qwen One', available: true, contextLimit: 32768, toolCapable: true }]);
    expect(fetcher).toHaveBeenCalledWith('http://100.80.53.57:1234/api/v1/models', expect.objectContaining({ redirect: 'error' }));
  });
  it('migrates old model settings without losing assignments', () => {
    const root = fixture();
    const filename = path.join(root, 'state.sqlite');
    const store = new Store(filename);
    store.close();
    const db = new DatabaseSync(filename);
    db.prepare("INSERT OR REPLACE INTO settings (key,data) VALUES ('app',?)").run(JSON.stringify({ endpoints: { ollama: 'http://127.0.0.1:4444', lmstudio: 'http://127.0.0.1:1234' }, defaultModel: { provider: 'ollama', model: 'old', contextLimit: 8192 }, overrides: {} }));
    db.close();
    const reopened = new Store(filename);
    expect(reopened.settings().connections.find(item => item.id === 'local-ollama')?.url).toBe('http://127.0.0.1:4444');
    expect(reopened.settings().defaultModel?.connectionId).toBe('local-ollama');
    expect(reopened.settings().connections.some(item => item.id === 'shared-lmstudio')).toBe(true);
    reopened.close();
  });
  it('joins fragmented LM Studio tool-call arguments before parsing', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"id1","function":{"name":"probe","arguments":"{\\"value\\":"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ready\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk))); controller.close(); } }), { status: 200 })));
    const providers = new LocalProviders(() => ({ connections: [{ id: 'local-lmstudio', provider: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234' }], defaultModel: null, overrides: {} }));
    const result = await providers.chat({ profile: { provider: 'lmstudio', model: 'fake', contextLimit: 8192 }, messages: [], signal: new AbortController().signal });
    expect(result.tools).toEqual([{ id: 'id1', name: 'probe', arguments: { value: 'ready' } }]);
  });
});
