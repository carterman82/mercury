import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatThread } from '../shared/types';
import { Store } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const database = () => { const root = mkdtempSync(path.join(os.tmpdir(), 'mercury-project-store-')); roots.push(root); return path.join(root, 'data.sqlite'); };
const thread = (id: string, projectId?: string): ChatThread => ({ id, projectId, title: 'Project request', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, messages: [], status: 'idle', updatedAt: 1 });

it('migrates version-three chats while preserving ordinary chats and legacy project defaults', () => {
  const filename = database();
  const old = new DatabaseSync(filename);
  old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES ('version','3'); CREATE TABLE projects (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE sessions (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE chats (id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE settings (key TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE secrets (key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  old.prepare('INSERT INTO projects VALUES (?,?)').run('project', JSON.stringify({ id: 'project', name: 'Existing', path: '/existing' }));
  old.prepare('INSERT INTO chats VALUES (?,?,?)').run('ordinary', 1, JSON.stringify(thread('ordinary')));
  old.prepare('INSERT INTO chats VALUES (?,?,?)').run('linked', 1, JSON.stringify(thread('linked', 'project')));
  old.close();
  const store = new Store(filename);
  try {
    expect(store.project('project')).toMatchObject({ permissionMode: 2, policyRevision: 1 });
    expect(store.chat('ordinary').projectId).toBeUndefined();
    expect(store.chat('linked').projectId).toBe('project');
    store.saveChat(store.chat('linked'));
  } finally { store.close(); }
  const migrated = new DatabaseSync(filename);
  try { expect(migrated.prepare("SELECT project_id FROM chats WHERE id = 'linked'").get()).toMatchObject({ project_id: 'project' }); }
  finally { migrated.close(); }
});

it('persists project ownership, rejects unknown projects and prevents chat reassignment', () => {
  const filename = database(), store = new Store(filename);
  try {
    store.saveProject({ id: 'one', name: 'One', path: '/one', permissionMode: 1, policyRevision: 2 });
    store.saveProject({ id: 'two', name: 'Two', path: '/two' });
    store.saveChat(thread('linked', 'one'));
    expect(() => store.saveChat(thread('bad', 'missing'))).toThrow('Project not found');
    expect(() => store.saveChat(thread('linked', 'two'))).toThrow('cannot be moved');
    expect(() => store.saveChat(thread('linked'))).toThrow('cannot be moved');
    expect(store.project('one')).toMatchObject({ permissionMode: 1, policyRevision: 2 });
    expect(store.chat('linked').projectId).toBe('one');
  } finally { store.close(); }
  const restored = new Store(filename);
  try { expect(restored.chat('linked').projectId).toBe('one'); } finally { restored.close(); }
});

it('recovers interrupted project chats without losing their project association', () => {
  const filename = database(), store = new Store(filename);
  store.saveProject({ id: 'one', name: 'One', path: '/one' });
  store.saveChat({ ...thread('active', 'one'), status: 'streaming' });
  store.close();
  const restored = new Store(filename);
  try { expect(restored.chat('active')).toMatchObject({ status: 'interrupted', projectId: 'one' }); }
  finally { restored.close(); }
});

it('recovers an interrupted schema migration whose new column already exists', () => {
  const filename = database();
  const first = new Store(filename); first.saveChat(thread('ordinary')); first.close();
  const interrupted = new DatabaseSync(filename);
  interrupted.prepare("UPDATE meta SET value = '3' WHERE key = 'version'").run(); interrupted.close();
  const recovered = new Store(filename);
  try { expect(recovered.chat('ordinary').projectId).toBeUndefined(); } finally { recovered.close(); }
});
