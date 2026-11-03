import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { mercuryGitEnvironment, mercuryProjectGitEnvironment } from './project-git-environment';

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

it('replaces inherited Git identity, credential configuration and GitHub tokens', () => {
  const base = { PATH: 'runtime', GIT_AUTHOR_NAME: 'Personal', GIT_CONFIG_COUNT: '12', GITHUB_TOKEN: 'personal', GH_TOKEN: 'personal', SSH_AUTH_SOCK: 'agent', GCM_CREDENTIAL_STORE: 'wincred' };
  const env = mercuryGitEnvironment(base, path.resolve('identity'));
  expect(env.PATH).toBe('runtime');
  expect(env.GIT_AUTHOR_NAME).toBe('Mercury AI');
  expect(env.GIT_COMMITTER_EMAIL).toBe('ai@mercury.local');
  expect(env.GIT_CONFIG_COUNT).toBe('3');
  expect(env.GIT_CONFIG_VALUE_0).toBe('');
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'GCM_CREDENTIAL_STORE']) expect(env[key]).toBeUndefined();
  expect(base.GIT_AUTHOR_NAME).toBe('Personal');
});

it('creates local Mercury commits while blocking remote publication even with repository overrides', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-git-identity-'));
  temporary.push(root);
  const env = mercuryGitEnvironment(process.env, path.join(root, 'identity'));
  const git = (...args: string[]) => execute('git', ['-C', root, ...args], { env, windowsHide: true });
  await git('init');
  await git('config', 'user.name', 'Personal');
  await git('config', 'user.email', 'personal@example.invalid');
  await git('config', 'protocol.file.allow', 'always');
  await fs.writeFile(path.join(root, 'app.txt'), 'local');
  await git('add', 'app.txt');
  await git('commit', '-m', 'Local safety history');
  expect((await git('log', '-1', '--format=%an|%ae|%cn|%ce')).stdout.trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
  expect((await git('config', 'user.name')).stdout.trim()).toBe('Personal');
  await expect(git('push', path.join(root, 'remote.git'), 'HEAD')).rejects.toMatchObject({ stderr: expect.stringContaining("transport 'file' not allowed") });
});

it('replaces inherited repository locations with absolute alternate Git paths', () => {
  const root = path.resolve('workspace');
  const env = mercuryProjectGitEnvironment({ GIT_DIR: 'personal.git', GIT_WORK_TREE: 'personal', GIT_INDEX_FILE: 'personal-index', GIT_OPTIONAL_LOCKS: '1' }, root);
  expect(env).toMatchObject({ GIT_DIR: path.join(root, '.mercury', 'git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(root, '.mercury', 'git', 'index'), GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Mercury AI', GIT_COMMITTER_EMAIL: 'ai@mercury.local' });
  expect(path.isAbsolute(env.GIT_CONFIG_GLOBAL!)).toBe(true);
});

it('ordinary project Git commands commit only to alternate history and leave personal refs, index and config untouched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-alternate-git-'));
  temporary.push(root);
  const personalEnv = { ...mercuryGitEnvironment(process.env, path.join(root, 'fixture-identity')), GIT_AUTHOR_NAME: 'Personal', GIT_AUTHOR_EMAIL: 'personal@example.invalid', GIT_COMMITTER_NAME: 'Personal', GIT_COMMITTER_EMAIL: 'personal@example.invalid' };
  const personalGit = (...args: string[]) => execute('git', ['-C', root, ...args], { env: personalEnv, windowsHide: true });
  await personalGit('init');
  await personalGit('config', 'user.name', 'Personal');
  await personalGit('config', 'user.email', 'personal@example.invalid');
  await personalGit('remote', 'add', 'origin', 'https://github.com/personal/project.git');
  await fs.writeFile(path.join(root, '.gitignore'), '/.mercury/\n');
  await fs.writeFile(path.join(root, 'app.txt'), 'personal baseline');
  await personalGit('add', '.gitignore', 'app.txt');
  await personalGit('commit', '-m', 'Personal baseline');
  await fs.writeFile(path.join(root, 'app.txt'), 'personal staged change');
  await personalGit('add', 'app.txt');
  const originalHead = (await personalGit('rev-parse', 'HEAD')).stdout;
  const originalRefs = (await personalGit('show-ref')).stdout;
  const originalIndex = await fs.readFile(path.join(root, '.git', 'index'));
  const originalConfig = await fs.readFile(path.join(root, '.git', 'config'));
  const env = mercuryProjectGitEnvironment(process.env, root);
  await fs.mkdir(path.join(root, '.mercury'), { recursive: true });
  const git = (...args: string[]) => execute('git', args, { cwd: root, env, windowsHide: true });
  await git(`--git-dir=${env.GIT_DIR}`, `--work-tree=${root}`, 'init');
  await fs.writeFile(path.join(root, 'app.txt'), 'Mercury change');
  await git('add', 'app.txt');
  await git('commit', '-m', 'Private Mercury history');
  expect((await git('rev-parse', '--git-dir')).stdout.trim()).toBe(env.GIT_DIR);
  expect((await git('log', '-1', '--format=%an|%ae|%cn|%ce')).stdout.trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
  expect((await git('show', 'HEAD:app.txt')).stdout).toBe('Mercury change');
  expect((await git('remote')).stdout).toBe('');
  await expect(git('push', path.join(root, 'remote.git'), 'HEAD')).rejects.toMatchObject({ stderr: expect.stringContaining("transport 'file' not allowed") });
  expect((await personalGit('rev-parse', 'HEAD')).stdout).toBe(originalHead);
  expect((await personalGit('show-ref')).stdout).toBe(originalRefs);
  expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(originalIndex);
  expect(await fs.readFile(path.join(root, '.git', 'config'))).toEqual(originalConfig);
  expect((await personalGit('show', ':app.txt')).stdout).toBe('personal staged change');
  expect((await personalGit('show', 'HEAD:app.txt')).stdout).toBe('personal baseline');
});
