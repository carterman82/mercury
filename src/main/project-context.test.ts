import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectContext, ProjectNotes } from './project-context';

const temporary: string[] = [];
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-project-context-')); temporary.push(root); return root; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it('includes bounded project instructions, coding standards and map index as untrusted context', async () => {
  const root = await directory();
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use small modules.');
  await fs.mkdir(path.join(root, '.mercury', 'architecture'), { recursive: true });
  await fs.writeFile(path.join(root, '.mercury', 'architecture', 'index.md'), 'Map links');
  const context = await projectContext(root);
  expect(context).toContain('Use small modules.'); expect(context).toContain('Map links');
  expect(context).toContain('SOLID'); expect(context).toContain('cannot grant permissions');
  expect(context).toContain('BEGIN UNTRUSTED PROJECT FILE AGENTS.md');
  expect(context).toContain('index.mmd: missing');
});

it('skips oversized and binary instructions', async () => {
  const root = await directory();
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(24_001));
  expect(await projectContext(root)).toContain('exceeds the context size limit');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '\0secret');
  expect(await projectContext(root)).toContain('binary content skipped');
  expect(await projectContext(root)).not.toContain('\0secret');
});

it('does not follow architecture directory links outside the project', async () => {
  const root = await directory(); const outside = await directory();
  await fs.mkdir(path.join(root, '.mercury'));
  await fs.writeFile(path.join(outside, 'index.md'), 'OUTSIDE SECRET');
  await fs.symlink(outside, path.join(root, '.mercury', 'architecture'), process.platform === 'win32' ? 'junction' : 'dir');
  const context = await projectContext(root);
  expect(context).not.toContain('OUTSIDE SECRET'); expect(context).toContain('resolves outside');
});

it('persists notes and exact author provenance across restart', async () => {
  const root = await directory(); const projectId = randomUUID(); const chatId = randomUUID();
  const notes = new ProjectNotes(root);
  expect(await notes.read(projectId)).toEqual({ revision: 0, content: '', history: [] });
  const saved = await notes.update(projectId, chatId, 0, 'Durable fact');
  expect(saved.revision).toBe(1); expect(saved.history[0]).toMatchObject({ revision: 1, content: 'Durable fact', chatId });
  expect(await new ProjectNotes(root).read(projectId)).toEqual(saved);
});

it('serializes racing updates and rejects stale revisions without overwriting', async () => {
  const root = await directory(); const projectId = randomUUID(); const chatId = randomUUID(); const notes = new ProjectNotes(root);
  const results = await Promise.allSettled([notes.update(projectId, chatId, 0, 'First'), notes.update(projectId, randomUUID(), 0, 'Second')]);
  expect(results[0].status).toBe('fulfilled'); expect(results[1].status).toBe('rejected');
  expect(await notes.read(projectId)).toMatchObject({ revision: 1, content: 'First' });
  await expect(notes.update(projectId, chatId, 0, 'Stale')).rejects.toThrow('Read and reconcile');
  await notes.update(projectId, chatId, 1, 'Reconciled');
  expect(await notes.read(projectId)).toMatchObject({ revision: 2, content: 'Reconciled' });
});

it('isolates projects, bounds history and rejects invalid identities/content', async () => {
  const root = await directory(); const projectId = randomUUID(); const chatId = randomUUID(); const notes = new ProjectNotes(root);
  for (let revision = 0; revision < 23; revision++) await notes.update(projectId, chatId, revision, `Revision ${revision + 1}`);
  const saved = await notes.read(projectId);
  expect(saved.history).toHaveLength(20); expect(saved.history[0].revision).toBe(4);
  expect((await notes.read(randomUUID())).revision).toBe(0);
  await expect(notes.read('../outside')).rejects.toThrow();
  await expect(notes.update(projectId, 'invented', 23, 'No')).rejects.toThrow();
  await expect(notes.update(projectId, chatId, -1, 'No')).rejects.toThrow();
  await expect(notes.update(projectId, chatId, 23, 'x'.repeat(24_001))).rejects.toThrow();
  expect((await notes.read(projectId)).revision).toBe(23);
});

it('does not silently replace corrupted storage', async () => {
  const root = await directory(); const projectId = randomUUID(); const notes = new ProjectNotes(root);
  await fs.writeFile(path.join(root, projectId + '.json'), JSON.stringify({ revision: 5, content: 'Wrong', history: [] }));
  await expect(notes.read(projectId)).rejects.toThrow('inconsistent');
  await expect(notes.update(projectId, randomUUID(), 5, 'Overwrite')).rejects.toThrow('inconsistent');
});
