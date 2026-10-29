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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-git-safety-'));
  temporary.push(base);
  const root = path.join(base, 'source');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 1;\n');
  if (repository) {
    await command(root, 'init');
    await command(root, 'config', 'user.email', 'tests@example.invalid');
    await command(root, 'config', 'user.name', 'Git safety tests');
    await command(root, 'add', '.');
    await command(root, 'commit', '-m', 'Initial fixture');
  }
  return { root, service: new ProjectWorktreeService(path.join(base, 'managed')) };
}
afterEach(async () => { for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('project Git safety', () => {
  it('uses the selected checkout instead of creating a duplicate project', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat' });
    expect(workspace).toMatchObject({ root, projectRoot: root, kind: 'direct', serialized: true });
  });

  it('initializes a non-Git project with a safe baseline and excludes secrets', async () => {
    const { root, service } = await fixture(false);
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    await service.prepare({ projectRoot: root, chatId: 'chat' });
    expect(await command(root, 'log', '-1', '--format=%s')).toBe('Mercury safety baseline\n');
    expect(await command(root, 'ls-files')).toContain('app.ts');
    expect(await command(root, 'ls-files')).not.toContain('.env.local');
    expect((await command(root, 'log', '-1', '--format=%an|%ae|%cn|%ce')).trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
  });

  it('commits eligible response changes and leaves sensitive files unstaged', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: '12345678-chat' });
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    const saved = await service.commitResponse(workspace);
    expect(saved).toMatchObject({ committed: true });
    expect((await command(root, 'log', '-1', '--format=%an|%ae|%cn|%ce')).trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
    expect((await command(root, 'config', 'user.name')).trim()).toBe('Git safety tests');
    expect((await command(root, 'config', 'user.email')).trim()).toBe('tests@example.invalid');
    expect(await command(root, 'log', '-1', '--format=%s')).toBe('Mercury: save response for 12345678\n');
    expect(await command(root, 'show', 'HEAD:app.ts')).toBe('export const value = 2;\n');
    expect(await command(root, 'status', '--porcelain')).toContain('.env.local');
  });

  it('does not create an empty commit', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat' });
    expect(await service.commitResponse(workspace)).toEqual({ committed: false });
  });

  it('detects and commits a file deletion from Git status', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'deletion' });
    await fs.unlink(path.join(root, 'app.ts'));
    expect(await service.changedPaths(workspace)).toEqual(['app.ts']);
    expect((await service.commitResponse(workspace)).committed).toBe(true);
    expect(await command(root, 'ls-files')).not.toContain('app.ts');
  });

  it('does not commit unrelated changes that predate the response', async () => {
    const { root, service } = await fixture();
    await fs.writeFile(path.join(root, 'unrelated.ts'), 'export const userChange = true;\n');
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat' });
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 3;\n');
    await service.commitResponse(workspace);
    expect(await command(root, 'show', 'HEAD:app.ts')).toBe('export const value = 3;\n');
    expect(await command(root, 'status', '--porcelain')).toContain('unrelated.ts');
  });
});
