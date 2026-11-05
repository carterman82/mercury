import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';
import type { ChatThread, SourceEvidence } from '../shared/types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'mercury-evidence-')); roots.push(root); return path.join(root, 'data.sqlite'); }
const evidence = (id: string, result: string, label = 'Saved source'): SourceEvidence => ({ id, at: 1234, tool: 'read_file', label, input: '{"path":"source.ts"}', result });
const chat = (id: string, items: SourceEvidence[]): ChatThread => ({ id, title: 'Evidence', profile: { provider: 'ollama', model: 'test', contextLimit: 8192 }, status: 'idle', updatedAt: 1, messages: [{ id: 'message', role: 'assistant', content: 'Done', sourceEvidence: items }] });

it('stores source bodies separately and restores exact provenance across restart', () => {
  const file = fixture(); let store = new Store(file);
  const item = evidence('source-id', 'BODY_UNIQUE_' + 'x'.repeat(100_000));
  store.saveChat(chat('one', [item])); store.close();
  const raw = new DatabaseSync(file);
  expect(String((raw.prepare('SELECT data FROM chats').get() as { data: string }).data)).not.toContain('BODY_UNIQUE');
  expect(raw.prepare('SELECT count(*) AS count FROM source_evidence').get()).toMatchObject({ count: 1 });
  raw.close();
  store = new Store(file);
  try {
    expect(store.chat('one').messages[0].sourceEvidence).toEqual([item]);
    expect(store.chats()[0].messages[0].sourceEvidence).toEqual([item]);
    const first = JSON.parse(store.recallSourceContext('chat', 'one', { id: item.id }, 1000));
    expect(first).toMatchObject({ id: item.id, at: 1234, tool: 'read_file', input: item.input, totalCharacters: item.result.length });
    expect(first.nextOffset).toBeGreaterThan(0);
  } finally { store.close(); }
});

it('ranks source terms with FTS and cannot read another chat or session source', () => {
  const store = new Store(fixture());
  try {
    store.saveChat(chat('one', [evidence('a', 'buffer connection buffer', 'SQLite buffer'), evidence('b', 'other buffer notes')]));
    store.saveChat(chat('two', [evidence('secret', 'buffer private source')]));
    store.indexSourceEvidence('session', 'one', [evidence('session-secret', 'buffer session private source')]);
    const page = JSON.parse(store.recallSourceContext('chat', 'one', { query: 'buffer connection' }));
    expect(page.matches.map((item: SourceEvidence) => item.id)).toEqual(['a']);
    expect(page.totalMatches).toBe(1);
    expect(JSON.parse(store.recallSourceContext('chat', 'one', { id: 'secret' })).error).toContain('this conversation');
    expect(JSON.parse(store.recallSourceContext('chat', 'one', { id: 'session-secret' })).error).toContain('this conversation');
    expect(JSON.parse(store.recallSourceContext('chat', 'one', { query: '" OR *' })).matches).toEqual([]);
    expect(JSON.parse(store.recallSourceContext('chat', 'one', { query: '*' })).matches).toEqual([]);
  } finally { store.close(); }
});

it('migrates legacy embedded evidence without changing observation IDs or chat timestamps', () => {
  const file = fixture(); const initial = new Store(file); initial.close();
  const item = evidence('legacy', 'migration evidence');
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO chats(id,updated_at,data) VALUES(?,?,?)').run('old', 456, JSON.stringify(chat('old', [item])));
  raw.prepare("UPDATE meta SET value='4' WHERE key='version'").run(); raw.close();
  const migrated = new Store(file);
  try {
    expect(migrated.chat('old').messages[0].sourceEvidence).toEqual([item]);
    expect(JSON.parse(migrated.recallSourceContext('chat', 'old', { query: 'migration' })).matches[0].id).toBe('legacy');
    migrated.saveChat(migrated.chat('old'));
    migrated.indexSourceEvidence('chat', 'old', [{ ...item, result: 'changed observation' }]);
    expect(JSON.parse(migrated.recallSourceContext('chat', 'old', { id: item.id })).content).toBe(item.result);
  } finally { migrated.close(); }
});

it('returns bounded ranked pages for long histories without loading entire evidence bodies', () => {
  const store = new Store(fixture());
  try {
    store.indexSourceEvidence('chat', 'long', Array.from({ length: 100 }, (_, n) => evidence(String(n), 'needle ' + 'padding '.repeat(10_000))));
    const page = JSON.parse(store.recallSourceContext('chat', 'long', { query: 'needle' }, 1500));
    expect(page.totalMatches).toBe(100);
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.matches.length).toBeLessThanOrEqual(15);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(1500);
  } finally { store.close(); }
});
