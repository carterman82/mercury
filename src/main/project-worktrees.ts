import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mercuryGitEnvironment } from './project-git-environment';

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

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.vite', '.next', 'coverage', '.cache', '__pycache__']);
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function eligible(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  if (parts[0].toLowerCase() === '.mercury') return false;
  return !parts.some(part => excludedDirectories.has(part.toLowerCase()))
    && !parts.some(part => /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part))
    && !/\.(?:pem|p12|pfx|key)$/i.test(relative);
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
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
    execFile('git', ['--literal-pathspecs', `--git-dir=${directory}`, `--work-tree=${root}`, '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'commit.gpgSign=false', '-C', root, ...args], { signal, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout));
  });
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
    if (paths.length) await git(root, ['add', '-A', '--', ...paths], signal);
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
      await git(workspace.projectRoot, ['add', '-A', '--', ...changed], signal);
      if (await succeeds(workspace.projectRoot, ['diff', '--cached', '--quiet', '--', ...changed], signal)) return { committed: false };
      await git(workspace.projectRoot, ['commit', '--no-verify', '--only', '-m', `Mercury: save response for ${workspace.chatId.slice(0, 8)}`, '--', ...changed], signal);
      return { committed: true, revision: (await git(workspace.projectRoot, ['rev-parse', '--short', 'HEAD'], signal)).trim() };
    });
  }

  /** Compatibility methods for older saved chats. Git history is now the recovery mechanism. */
  async review(id: string): Promise<ProjectWorkspaceReview> { throw new Error(`Workspace review is unavailable for ${id}; changes are saved automatically at the end of a successful response.`); }
  async integrate(id: string, _token: string, _signal?: AbortSignal): Promise<ProjectWorkspaceReview> { throw new Error(`Workspace integration is unavailable for ${id}; edits already apply to the project checkout.`); }
}
