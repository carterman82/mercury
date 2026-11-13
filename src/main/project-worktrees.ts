import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mercuryGitEnvironment } from './project-git-environment';
import type { ProjectDiff } from '../shared/types';

export interface ProjectWorkspace {
  id: string;
  chatId: string;
  projectRoot: string;
  root: string;
  /** Projects use their real checkout; this name remains for saved-chat compatibility. */
  kind: 'direct';
  /** One checkout has one writer at a time. */
  serialized: true;
}
export interface ProjectWorkspaceChange {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  beforeMode: number | null;
  afterMode: number | null;
  before: string | null;
  after: string | null;
  binary: boolean;
}
export interface ProjectWorkspaceReview {
  workspace: ProjectWorkspace;
  token: string;
  changes: ProjectWorkspaceChange[];
}

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.vite', '.next', 'coverage', '.cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'venv']);
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function eligible(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  if (parts[0].toLowerCase() === '.mercury') return false;
  return !parts.some(part => excludedDirectories.has(part.toLowerCase()) || /^\.venv(?:[-_].*)?$/i.test(part))
    && !parts.some(part => /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part))
    && !/\.(?:pem|p12|pfx|key)$/i.test(relative);
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function git(root: string, args: string[], signal?: AbortSignal, input?: string): Promise<string> {
  aborted(signal);
  // Never discover or reuse the checkout's .git (including linked worktrees).
  const directory = path.join(root, '.mercury', 'git');
  for (const target of [path.dirname(directory), directory]) {
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('Mercury Git storage must be a separate regular directory, not a link.');
  }
  for (const relative of ['config', 'HEAD', 'index', 'refs', 'refs/heads', 'refs/heads/mercury', 'objects', 'logs', 'logs/HEAD', 'logs/refs', 'logs/refs/heads', 'logs/refs/heads/mercury', 'commondir', 'objects/info/alternates']) {
    const stat = await fs.lstat(path.join(directory, relative)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && (stat.isSymbolicLink() || relative === 'commondir' || relative === 'objects/info/alternates')) throw new Error('Mercury Git storage cannot link or share metadata with another repository.');
  }
  await fs.mkdir(path.dirname(directory), { recursive: true });
  return new Promise((resolve, reject) => {
    const env = mercuryGitEnvironment(process.env, path.join(root, '.mercury', 'identity'));
    const child = execFile('git', ['--literal-pathspecs', `--git-dir=${directory}`, `--work-tree=${root}`, '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'commit.gpgSign=false', '-C', root, ...args], { signal, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout));
    child.stdin!.on('error', reject);
    child.stdin!.end(input);
  });
}
function gitPaths(root: string, args: string[], paths: string[], signal?: AbortSignal): Promise<string> {
  // Keep filenames out of argv: large projects exceed Windows' command limit.
  // NUL separators and literal pathspecs preserve spaces, newlines and metacharacters.
  return git(root, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], signal, paths.join('\0') + '\0');
}
async function succeeds(root: string, args: string[], signal?: AbortSignal): Promise<boolean> {
  try { await git(root, args, signal); return true; } catch { return false; }
}

/** Separate local safety history; the project's own Git repository is never used. */
export class ProjectWorktreeService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly baselines = new Map<string, Map<string, string>>();
  private readonly repositories = new Set<string>();
  constructor(readonly storageRoot: string) {}

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(key, next);
    try { return await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
  private id(projectRoot: string, chatId: string): string {
    const identity = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
    return digest(`${identity}\0${chatId}`);
  }
  private async eligiblePaths(root: string, signal?: AbortSignal): Promise<string[]> {
    const names = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)).split('\0');
    return [...new Set(names)].filter(name => name && eligible(name)).sort();
  }
  private async stageEligible(root: string, signal?: AbortSignal): Promise<void> {
    const paths = await this.eligiblePaths(root, signal);
    if (paths.length) await gitPaths(root, ['add', '-A'], paths, signal);
  }
  private async snapshotEligible(root: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();
    for (const relative of await this.eligiblePaths(root, signal)) {
      aborted(signal);
      const stat = await fs.lstat(path.join(root, relative)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat && !stat.isFile()) continue;
      const content = await fs.readFile(path.join(root, relative)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      snapshot.set(relative, content ? digest(content) : 'deleted');
    }
    return snapshot;
  }
  private async ensureRepository(root: string, signal?: AbortSignal): Promise<void> {
    if (this.repositories.has(root)) return;
    await git(root, ['init', '--initial-branch=mercury', '--template='], signal);
    await git(root, ['config', '--local', 'user.name', 'Mercury AI'], signal);
    await git(root, ['config', '--local', 'user.email', 'ai@mercury.local'], signal);
    if ((await git(root, ['remote'], signal)).trim()) throw new Error('Mercury safety history must not have remotes.');
    if (await succeeds(root, ['rev-parse', '--verify', 'HEAD'], signal)) { this.repositories.add(root); return; }
    await this.stageEligible(root, signal);
    if (!(await succeeds(root, ['diff', '--cached', '--quiet'], signal))) await git(root, ['commit', '--no-verify', '-m', 'Mercury safety baseline'], signal);
    this.repositories.add(root);
  }

  async initialize(projectRoot: string, signal?: AbortSignal): Promise<void> {
    const root = await fs.realpath(projectRoot);
    await this.exclusive(root, async () => {
      const filename = path.join(root, '.gitignore');
      const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Project .gitignore must be a regular file.');
      const content = stat ? await fs.readFile(filename, 'utf8') : '';
      if (!content.split(/\r?\n/).some(line => line.trim() === '/.mercury/')) {
        await fs.appendFile(filename, `${content && !content.endsWith('\n') ? '\n' : ''}/.mercury/\n`);
      }
      await this.ensureRepository(root, signal);
    });
  }

  async prepare(input: { projectRoot: string; chatId: string; signal?: AbortSignal }): Promise<ProjectWorkspace> {
    if (!input.chatId.trim()) throw new Error('Chat identity is required.');
    const projectRoot = await fs.realpath(input.projectRoot);
    if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error('Project must be a directory.');
    await this.initialize(projectRoot, input.signal);
    return this.exclusive(projectRoot, async () => {
      aborted(input.signal);
      await this.ensureRepository(projectRoot, input.signal);
      const workspace = { id: this.id(projectRoot, input.chatId), chatId: input.chatId, projectRoot, root: projectRoot, kind: 'direct' as const, serialized: true as const };
      this.baselines.set(workspace.id, await this.snapshotEligible(projectRoot, input.signal));
      return workspace;
    });
  }

  async load(_id: string): Promise<ProjectWorkspace> { throw new Error('Project workspaces are no longer persisted; reopen the project chat.'); }

  /** Read-only inspection of the latest saved response and subsequent working edits. */
  async changes(projectRoot: string): Promise<ProjectDiff> {
    const root = await fs.realpath(projectRoot);
    const directory = path.join(root, '.mercury', 'git');
    if (!(await fs.stat(directory).catch(() => null))?.isDirectory()) return { baseLabel: 'No Mercury checkpoint exists yet.', changes: [], truncated: false };
    if (!(await succeeds(root, ['rev-parse', '--verify', 'HEAD']))) return { baseLabel: 'No Mercury checkpoint exists yet.', changes: [], truncated: false };
    const parent = await succeeds(root, ['rev-parse', '--verify', 'HEAD^']);
    const revision = parent ? (await git(root, ['rev-parse', 'HEAD^'])).trim() : null;
    const candidates = revision
      ? [...(await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', revision, '--'])).split('\0'), ...(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')]
      : await this.eligiblePaths(root);
    const paths = [...new Set(candidates)].filter(name => name && eligible(name)).sort();
    const changes: ProjectDiff['changes'] = [];
    let budget = 4_000_000, truncated = paths.length > 100;
    for (const relative of paths.slice(0, 100)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) continue;
      const filename = path.join(root, relative);
      const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat && !stat.isFile()) continue;
      if (stat) {
        const real = await fs.realpath(filename);
        const rel = path.relative(root, real);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      }
      const object = revision ? `${revision}:${relative}` : null;
      let before: Buffer | null = null, after: Buffer | null = null;
      let binary = Boolean(stat && stat.size > 512_000);
      if (object && await succeeds(root, ['cat-file', '-e', object])) {
        const size = Number((await git(root, ['cat-file', '-s', object])).trim());
        if (size > 512_000) binary = true;
        else before = Buffer.from(await git(root, ['show', object]), 'utf8');
      }
      if (stat && !binary) {
        const handle = await fs.open(filename, 'r');
        try {
          const buffer = Buffer.alloc(512_001);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 512_000) binary = true;
          else after = buffer.subarray(0, bytesRead);
        } finally { await handle.close(); }
      }
      binary ||= Boolean(before?.includes(0) || after?.includes(0));
      const bytes = (before?.length ?? 0) + (after?.length ?? 0);
      if (bytes > budget) { truncated = true; break; }
      budget -= bytes;
      if (!binary && before === null && after === null) continue;
      if (!binary && before?.equals(after ?? Buffer.alloc(0)) && after !== null) continue;
      changes.push({ path: relative, before: binary ? null : before?.toString('utf8') ?? null, after: binary ? null : after?.toString('utf8') ?? null, binary });
    }
    return { baseLabel: revision ? `Latest saved project response and working edits, compared with checkpoint ${revision.slice(0, 8)}.` : 'Initial project checkpoint and working edits, compared with an empty project.', changes, truncated };
  }

  async changedPaths(workspace: ProjectWorkspace, signal?: AbortSignal): Promise<string[]> {
    const baseline = this.baselines.get(workspace.id) ?? new Map<string, string>();
    const current = await this.snapshotEligible(workspace.root, signal);
    return [...new Set([...baseline.keys(), ...current.keys()])].filter(relative => baseline.get(relative) !== current.get(relative)).sort();
  }

  /** Commit only safe project files. A clean checkout produces no commit. */
  async commitResponse(workspace: ProjectWorkspace, signal?: AbortSignal): Promise<{ committed: boolean; revision?: string }> {
    return this.exclusive(workspace.projectRoot, async () => {
      aborted(signal);
      await this.ensureRepository(workspace.projectRoot, signal);
      const baseline = this.baselines.get(workspace.id) ?? new Map<string, string>();
      const current = await this.snapshotEligible(workspace.projectRoot, signal);
      const changed = [...new Set([...baseline.keys(), ...current.keys()])].filter(relative => baseline.get(relative) !== current.get(relative)).sort();
      if (!changed.length) return { committed: false };
      await gitPaths(workspace.projectRoot, ['add', '-A'], changed, signal);
      const staged = new Set((await git(workspace.projectRoot, ['diff', '--cached', '--no-renames', '--name-only', '-z', '--'], signal)).split('\0'));
      if (!changed.some(relative => staged.has(relative))) return { committed: false };
      await gitPaths(workspace.projectRoot, ['commit', '--no-verify', '--only', '-m', `Mercury: save response for ${workspace.chatId.slice(0, 8)}`], changed, signal);
      return { committed: true, revision: (await git(workspace.projectRoot, ['rev-parse', '--short', 'HEAD'], signal)).trim() };
    });
  }

  /** Compatibility methods for older saved chats. Git history is now the recovery mechanism. */
  async review(id: string): Promise<ProjectWorkspaceReview> { throw new Error(`Workspace review is unavailable for ${id}; changes are saved automatically at the end of a successful response.`); }
  async integrate(id: string, _token: string, _signal?: AbortSignal): Promise<ProjectWorkspaceReview> { throw new Error(`Workspace integration is unavailable for ${id}; edits already apply to the project checkout.`); }
}
