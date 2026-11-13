import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWorktreeService } from './project-worktrees';

const execute = promisify(execFile);
const temporary: string[] = [];
async function command(root: string, ...args: string[]) {
  return (await execute('git', ['-C', root, ...args], { windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}
async function mercury(root: string, ...args: string[]) {
  return command(root, '--git-dir', path.join(root, '.mercury', 'git'), '--work-tree', root, ...args);
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, item.name);
      if (item.isDirectory()) await walk(filename);
      else if (item.isFile()) result[path.relative(directory, filename).replaceAll('\\', '/')] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
      else throw new Error(`Unexpected Git metadata link: ${filename}`);
    }
  };
  await walk(directory);
  return result;
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
  async function largeProject(root: string): Promise<string[]> {
    const directory = 'source-with-a-long-directory-name-'.repeat(3);
    await fs.mkdir(path.join(root, directory));
    const names = Array.from({ length: 240 }, (_, index) => `${directory}/module-${String(index).padStart(4, '0')}-${'long-name-'.repeat(5)}.ts`);
    expect(names.join('\0').length).toBeGreaterThan(32767);
    await Promise.all(names.map(name => fs.writeFile(path.join(root, name), 'original\n')));
    return names;
  }

  it('opens a project whose eligible filenames exceed the Windows command limit', async () => {
    const { root, service } = await fixture(false);
    const names = await largeProject(root);
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    await service.initialize(root);
    const tracked = (await mercury(root, 'ls-files', '-z')).split('\0').filter(Boolean);
    expect(tracked).toEqual(expect.arrayContaining(names));
    expect(tracked).toHaveLength(names.length + 2); // app.ts and .gitignore
    expect(tracked).not.toContain('.env.local');
    expect(await mercury(root, 'log', '-1', '--format=%s')).toBe('Mercury safety baseline\n');
  }, 30000);

  it('saves a response whose changed filenames exceed the Windows command limit', async () => {
    const { root, service } = await fixture(false);
    const workspace = await service.prepare({ projectRoot: root, chatId: 'large-response' });
    const names = await largeProject(root);
    await fs.unlink(path.join(root, 'app.ts'));
    const special = '-literal [file] café.ts';
    await fs.writeFile(path.join(root, special), 'literal filename\n');
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    expect(await service.commitResponse(workspace)).toMatchObject({ committed: true });
    const changed = (await mercury(root, 'diff', 'HEAD^', 'HEAD', '--name-only', '-z')).split('\0').filter(Boolean);
    expect(changed).toEqual(expect.arrayContaining([...names, 'app.ts', special]));
    expect(changed).toHaveLength(names.length + 2);
    expect(await mercury(root, 'show', `HEAD:${special}`)).toBe('literal filename\n');
    expect(await mercury(root, 'ls-files')).not.toContain('.env.local');
  }, 30000);

  it('saves a deletion when Git pairs it with an unrelated staged file as a rename', async () => {
    const { root, service } = await fixture(false);
    await service.initialize(root);
    await fs.copyFile(path.join(root, 'app.ts'), path.join(root, 'unrelated.ts'));
    await mercury(root, 'add', '--', 'unrelated.ts');
    const workspace = await service.prepare({ projectRoot: root, chatId: 'staged-rename' });
    await fs.unlink(path.join(root, 'app.ts'));
    expect(await service.commitResponse(workspace)).toMatchObject({ committed: true });
    expect((await mercury(root, 'diff', 'HEAD^', 'HEAD', '--name-only')).trim()).toBe('app.ts');
    expect((await mercury(root, 'diff', '--cached', '--name-only')).trim()).toBe('unrelated.ts');
  });

  it('reviews the latest saved response and working edits without modifying either history', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'diff-review' });
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
    await service.commitResponse(workspace);
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 3;\n');
    await fs.writeFile(path.join(root, 'added.ts'), 'new source');
    await fs.writeFile(path.join(root, '.env'), 'DO_NOT_REVEAL');
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]));
    const before = await snapshot(path.join(root, '.git'));
    const checkpoint = await mercury(root, 'rev-parse', 'HEAD');
    const review = await service.changes(root);
    expect(review.changes).toContainEqual({ path: 'app.ts', before: 'export const value = 1;\n', after: 'export const value = 3;\n', binary: false });
    expect(review.changes).toContainEqual({ path: 'added.ts', before: null, after: 'new source', binary: false });
    expect(review.changes).toContainEqual({ path: 'image.bin', before: null, after: null, binary: true });
    expect(JSON.stringify(review)).not.toContain('DO_NOT_REVEAL');
    expect(await snapshot(path.join(root, '.git'))).toEqual(before);
    expect(await mercury(root, 'rev-parse', 'HEAD')).toBe(checkpoint);
  });

  it('does not create checkpoint storage merely to open an empty review', async () => {
    const { root, service } = await fixture(false);
    expect(await service.changes(root)).toEqual({ baseLabel: 'No Mercury checkpoint exists yet.', changes: [], truncated: false });
    expect(await fs.stat(path.join(root, '.mercury')).catch(() => null)).toBeNull();
  });
  it('keeps created Python environments and test caches out of local checkpoints', async () => {
    const { root, service } = await fixture(false);
    const workspace = await service.prepare({ projectRoot: root, chatId: 'python-setup' });
    for (const folder of ['.venv', '.venv_test', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache']) {
      await fs.mkdir(path.join(root, folder));
      await fs.writeFile(path.join(root, folder, 'generated.py'), 'generated runtime/cache');
    }
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
    expect(await service.changedPaths(workspace)).toEqual(['app.ts']);
    await service.commitResponse(workspace);
    const tracked = await mercury(root, 'ls-files');
    expect(tracked).toContain('app.ts');
    expect(tracked).not.toMatch(/venv|pytest_cache|mypy_cache|ruff_cache/);
  });
  it('initializes on opening without a chat and preserves existing ignore rules', async () => {
    const { root, service } = await fixture(false);
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/');
    await fs.mkdir(path.join(root, '.mercury'));
    await fs.writeFile(path.join(root, '.mercury', 'state.json'), '{}');
    await service.initialize(root);
    await service.initialize(root);
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n/.mercury/\n');
    expect(await mercury(root, 'ls-files')).not.toContain('.mercury');
    expect(await mercury(root, 'log', '-1', '--format=%s')).toContain('Mercury safety baseline');
    expect((await mercury(root, 'rev-list', '--count', 'HEAD')).trim()).toBe('1');
    await expect(fs.stat(path.join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses the selected checkout instead of creating a duplicate project', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat' });
    expect(workspace).toMatchObject({ root, projectRoot: root, kind: 'direct', serialized: true });
  });

  it('initializes a non-Git project with a safe baseline and excludes secrets', async () => {
    const { root, service } = await fixture(false);
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    await service.prepare({ projectRoot: root, chatId: 'chat' });
    expect(await mercury(root, 'log', '-1', '--format=%s')).toBe('Mercury safety baseline\n');
    expect(await mercury(root, 'ls-files')).toContain('app.ts');
    expect(await mercury(root, 'ls-files')).not.toContain('.env.local');
    expect((await mercury(root, 'log', '-1', '--format=%an|%ae|%cn|%ce')).trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
    expect((await mercury(root, 'config', '--local', 'user.name')).trim()).toBe('Mercury AI');
    expect((await mercury(root, 'config', '--local', 'user.email')).trim()).toBe('ai@mercury.local');
    expect(await mercury(root, 'remote')).toBe('');
    await expect(fs.stat(path.join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits eligible response changes and leaves sensitive files unstaged', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: '12345678-chat' });
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
    const saved = await service.commitResponse(workspace);
    expect(saved).toMatchObject({ committed: true });
    expect((await mercury(root, 'log', '-1', '--format=%an|%ae|%cn|%ce')).trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
    expect((await command(root, 'config', 'user.name')).trim()).toBe('Git safety tests');
    expect((await command(root, 'config', 'user.email')).trim()).toBe('tests@example.invalid');
    expect(await mercury(root, 'log', '-1', '--format=%s')).toBe('Mercury: save response for 12345678\n');
    expect(await mercury(root, 'show', 'HEAD:app.ts')).toBe('export const value = 2;\n');
    expect(await command(root, 'show', 'HEAD:app.ts')).toBe('export const value = 1;\n');
    expect(await command(root, 'status', '--porcelain')).toContain('.env.local');
  });

  it('does not create an empty commit', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat' });
    expect(await service.commitResponse(workspace)).toEqual({ committed: false });
  });

  it('detects and records a file deletion only in Mercury history', async () => {
    const { root, service } = await fixture();
    const workspace = await service.prepare({ projectRoot: root, chatId: 'deletion' });
    await fs.unlink(path.join(root, 'app.ts'));
    expect(await service.changedPaths(workspace)).toEqual(['app.ts']);
    expect((await service.commitResponse(workspace)).committed).toBe(true);
    expect(await mercury(root, 'ls-files')).not.toContain('app.ts');
    expect(await command(root, 'ls-files')).toContain('app.ts');
  });

  it('does not commit unrelated changes that predate the response', async () => {
    const { root, service } = await fixture();
    await fs.writeFile(path.join(root, 'unrelated.ts'), 'export const userChange = true;\n');
    const workspace = await service.prepare({ projectRoot: root, chatId: 'chat' });
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 3;\n');
    await service.commitResponse(workspace);
    expect(await mercury(root, 'show', 'HEAD:app.ts')).toBe('export const value = 3;\n');
    expect((await mercury(root, 'diff', 'HEAD^', 'HEAD', '--name-only')).trim()).toBe('app.ts');
    expect(await command(root, 'status', '--porcelain')).toContain('unrelated.ts');
  });

  it('never changes the personal Git metadata or remote when preparing and saving project responses', async () => {
    const { root, service } = await fixture();
    const remote = path.join(path.dirname(root), 'personal-remote.git');
    await fs.mkdir(remote);
    await command(remote, 'init', '--bare');
    await command(root, 'remote', 'add', 'origin', remote);
    await command(root, 'push', 'origin', 'HEAD:refs/heads/main');
    await fs.writeFile(path.join(root, 'app.ts'), 'user staged version\n');
    await fs.writeFile(path.join(root, 'staged.txt'), 'user staged addition\n');
    await command(root, 'add', 'app.ts', 'staged.txt');
    await fs.writeFile(path.join(root, 'app.ts'), 'user unstaged version\n');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'user untracked addition\n');
    const personalBefore = await snapshot(path.join(root, '.git'));
    const remoteBefore = await snapshot(remote);
    expect(personalBefore).toHaveProperty('HEAD');
    expect(personalBefore).toHaveProperty('index');
    expect(personalBefore).toHaveProperty('config');
    expect(Object.keys(personalBefore).some(name => name.startsWith('refs/heads/'))).toBe(true);
    expect(Object.keys(personalBefore).some(name => name.startsWith('logs/'))).toBe(true);

    await service.initialize(root);
    const workspace = await service.prepare({ projectRoot: root, chatId: 'personal-isolation' });
    expect(await snapshot(path.join(root, '.git'))).toEqual(personalBefore);
    await fs.writeFile(path.join(root, 'app.ts'), 'Mercury response edit\n');
    await service.commitResponse(workspace);
    expect(await snapshot(path.join(root, '.git'))).toEqual(personalBefore);
    expect(await snapshot(remote)).toEqual(remoteBefore);
    expect(await command(root, 'show', ':app.ts')).toBe('user staged version\n');
    expect(await command(root, 'show', ':staged.txt')).toBe('user staged addition\n');
    expect(await command(root, 'show', 'HEAD:app.ts')).toBe('export const value = 1;\n');
    expect(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('user untracked addition\n');
    expect(await mercury(root, 'show', 'HEAD:app.ts')).toBe('Mercury response edit\n');
    expect(await mercury(root, 'remote')).toBe('');
    expect((await mercury(root, 'log', '-1', '--format=%an|%ae|%cn|%ce')).trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
    expect(await command(root, 'remote', 'get-url', 'origin')).toBe(remote + '\n');
  });

  it('rejects alternate Git directories linked to the personal repository', async () => {
    const { root, service } = await fixture();
    const before = await snapshot(path.join(root, '.git'));
    await fs.mkdir(path.join(root, '.mercury'));
    await fs.symlink(path.join(root, '.git'), path.join(root, '.mercury', 'git'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.initialize(root)).rejects.toThrow();
    expect(await snapshot(path.join(root, '.git'))).toEqual(before);
  });
  it('rejects linked-worktree metadata that would share the personal repository', async () => {
    const { root, service } = await fixture();
    const before = await snapshot(path.join(root, '.git'));
    await fs.mkdir(path.join(root, '.mercury', 'git'), { recursive: true });
    await fs.writeFile(path.join(root, '.mercury', 'git', 'commondir'), path.join(root, '.git'));
    await expect(service.initialize(root)).rejects.toThrow('share metadata');
    expect(await snapshot(path.join(root, '.git'))).toEqual(before);
  });
});
