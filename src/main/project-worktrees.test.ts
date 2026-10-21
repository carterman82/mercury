import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorktreeService } from './project-worktrees';

const execute = promisify(execFile);
const temporary: string[] = [];
async function command(root: string, ...args: string[]) {
  return (await execute('git', ['-C', root, ...args], { windowsHide: true })).stdout;
}
async function fixture(repository = true) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-worktree-'));
  temporary.push(base);
  const root = path.join(base, 'source');
  const storage = path.join(base, 'managed');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'other.txt'), 'original\n');
  if (repository) {
    await command(root, 'init');
    await command(root, 'config', 'user.email', 'tests@example.invalid');
    await command(root, 'config', 'user.name', 'Workspace tests');
    await command(root, 'add', '.');
    await command(root, 'commit', '-m', 'Initial fixture');
  }
  return { root, storage, service: new ProjectWorktreeService(storage) };
}
afterEach(async () => {
  for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('project worktrees', () => {
  it('captures staged, unstaged and eligible untracked content without touching the source index or branch', async () => {
    const { root, service } = await fixture();
    await fs.writeFile(path.join(root, 'app.ts'), 'staged\n');
    await command(root, 'add', 'app.ts');
    await fs.writeFile(path.join(root, 'app.ts'), 'dirty\n');
    await fs.writeFile(path.join(root, 'new.ts'), 'new\n');
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'cache'), 'cache');
    const status = await command(root, 'status', '--porcelain=v1');
    const staged = await command(root, 'diff', '--cached');
    const head = await command(root, 'rev-parse', 'HEAD');
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat/unsafe-id' });
    expect(workspace.kind).toBe('git-worktree');
    expect(workspace.root.startsWith(root)).toBe(false);
    expect(await fs.readFile(path.join(workspace.root, 'app.ts'), 'utf8')).toBe('dirty\n');
    expect(await fs.readFile(path.join(workspace.root, 'new.ts'), 'utf8')).toBe('new\n');
    for (const name of ['.env.local', 'ignored.txt', 'node_modules']) expect(await fs.stat(path.join(workspace.root, name)).catch(() => null)).toBeNull();
    expect((await service.review(workspace.id)).changes).toEqual([]);
    expect(await command(root, 'status', '--porcelain=v1')).toBe(status);
    expect(await command(root, 'diff', '--cached')).toBe(staged);
    expect(await command(root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('integrates exact additions, edits and deletions while preserving unrelated edits and source staging', async () => {
    const { root, service } = await fixture();
    await fs.writeFile(path.join(root, 'app.ts'), 'existing user changes\n');
    await command(root, 'add', 'app.ts');
    const staged = await command(root, 'diff', '--cached');
    const workspace = await service.prepare({ projectRoot: root, chatId: 'coding' });
    await fs.writeFile(path.join(workspace.root, 'app.ts'), 'agent changes\n');
    await fs.writeFile(path.join(workspace.root, 'new.ts'), 'new script\n');
    await fs.unlink(path.join(workspace.root, 'other.txt'));
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'user edits during coding\n');
    const review = await service.review(workspace.id);
    expect(review.changes.map(change => change.path)).toEqual(['app.ts', 'new.ts', 'other.txt']);
    expect(review.changes[0].before).toBe('existing user changes\n');
    await service.integrate(workspace.id, review.token);
    expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('agent changes\n');
    expect(await fs.readFile(path.join(root, 'new.ts'), 'utf8')).toBe('new script\n');
    expect(await fs.stat(path.join(root, 'other.txt')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8')).toBe('user edits during coding\n');
    expect(await command(root, 'diff', '--cached')).toBe(staged);
    expect((await service.review(workspace.id)).changes).toEqual([]);
    await expect(service.integrate(workspace.id, review.token)).rejects.toThrow('changed after review');
  });

  it('rejects stale worktree review and touched source conflicts before modifying any source file', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'coding' });
    await fs.writeFile(path.join(workspace.root, 'app.ts'), 'first\n');
    const review = await service.review(workspace.id);
    await fs.writeFile(path.join(workspace.root, 'app.ts'), 'second\n');
    await expect(service.integrate(workspace.id, review.token)).rejects.toThrow('changed after review');
    const next = await service.review(workspace.id);
    await fs.writeFile(path.join(root, 'app.ts'), 'concurrent user edit\n');
    await expect(service.integrate(workspace.id, next.token)).rejects.toThrow('Project changed since baseline');
    expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('concurrent user edit\n');
    expect(await fs.readFile(path.join(workspace.root, 'app.ts'), 'utf8')).toBe('second\n');
  });

  it('recovers persisted workspaces across service restarts and distinguishes chat ownership', async () => {
    const { root, storage, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'one' });
    await fs.writeFile(path.join(workspace.root, 'app.ts'), 'interrupted work');
    const restarted = new ProjectWorktreeService(storage);
    expect(await restarted.prepare({ projectRoot: root, chatId: 'one' })).toEqual(workspace);
    expect((await restarted.review(workspace.id)).changes[0].after).toBe('interrupted work');
    expect((await restarted.prepare({ projectRoot: root, chatId: 'two' })).root).not.toBe(workspace.root);
    await expect(restarted.load('../source')).rejects.toThrow('Invalid workspace identity');
  });

  it('keeps cancelled integrations isolated and rejects pre-cancelled preparation', async () => {
    const { root, service } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(service.prepare({ projectRoot: root, chatId: 'cancelled', signal: controller.signal })).rejects.toThrow();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'active' });
    await fs.writeFile(path.join(workspace.root, 'app.ts'), 'pending edits');
    const review = await service.review(workspace.id);
    await expect(service.integrate(workspace.id, review.token, controller.signal)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect((await service.review(workspace.id)).token).toBe(review.token);
  });

  it('uses serialized direct workspace metadata for non-Git folders', async () => {
    const { root, service } = await fixture(false);
    const workspace = await service.prepare({ projectRoot: root, chatId: 'plain' });
    expect(workspace).toMatchObject({ kind: 'direct', root, serialized: true });
    await expect(service.review(workspace.id)).rejects.toThrow('serialized edits');
  });

  it('rejects storage inside the project and nested repository roots', async () => {
    const { root, service } = await fixture();
    await expect(new ProjectWorktreeService(path.join(root, 'unsafe')).prepare({ projectRoot: root, chatId: 'x' })).rejects.toThrow('storage must be separate');
    const child = path.join(root, 'child');
    await fs.mkdir(child);
    await expect(service.prepare({ projectRoot: child, chatId: 'x' })).rejects.toThrow('repository root');
  });

  it('rejects source junctions instead of writing outside the project', async () => {
    const { root, service } = await fixture();
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'file.ts'), 'baseline');
    await command(root, 'add', 'nested');
    await command(root, 'commit', '-m', 'Nested fixture');
    const workspace = await service.prepare({ projectRoot: root, chatId: 'links' });
    await fs.writeFile(path.join(workspace.root, 'nested', 'file.ts'), 'agent');
    const review = await service.review(workspace.id);
    const external = path.join(path.dirname(root), 'external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'file.ts'), 'baseline');
    await fs.rm(path.join(root, 'nested'), { recursive: true });
    await fs.symlink(external, path.join(root, 'nested'), 'junction');
    await expect(service.integrate(workspace.id, review.token)).rejects.toThrow('Linked paths');
    expect(await fs.readFile(path.join(external, 'file.ts'), 'utf8')).toBe('baseline');
  });
});
