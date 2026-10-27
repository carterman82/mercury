import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  const mapPath = parts.join('/');
  if (/^\.mercury\/architecture\/(?:generated\/|(?:graph\.json|manifest\.json|index\.md)$)/.test(mapPath)) return false;
  return !parts.some(part => excludedDirectories.has(part.toLowerCase()))
    && !parts.some(part => /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part))
    && !/\.(?:pem|p12|pfx|key)$/i.test(relative);
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-C', root, ...args], { signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout));
  });
}
async function succeeds(root: string, args: string[], signal?: AbortSignal): Promise<boolean> {
  try { await git(root, args, signal); return true; } catch { return false; }
}

/** A Git safety net that uses the selected checkout instead of copying projects. */
export class ProjectWorktreeService {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly baselines = new Map<string, Map<string, string>>();
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
      const content = await fs.readFile(path.join(root, relative)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (content) snapshot.set(relative, digest(content));
    }
    return snapshot;
  }
  private async configureIdentity(root: string, signal?: AbortSignal): Promise<void> {
    if (!(await succeeds(root, ['config', 'user.name'], signal))) await git(root, ['config', 'user.name', 'Mercury Safety Net'], signal);
    if (!(await succeeds(root, ['config', 'user.email'], signal))) await git(root, ['config', 'user.email', 'safety-net@mercury.local'], signal);
  }
  private async ensureRepository(root: string, signal?: AbortSignal): Promise<void> {
    if (await succeeds(root, ['rev-parse', '--is-inside-work-tree'], signal)) {
      const top = await fs.realpath((await git(root, ['rev-parse', '--show-toplevel'], signal)).trim());
      if (top !== root) throw new Error('Choose the repository root, not a nested folder.');
      return;
    }
    await git(root, ['init'], signal);
    await this.configureIdentity(root, signal);
    await this.stageEligible(root, signal);
    if (!(await succeeds(root, ['diff', '--cached', '--quiet'], signal))) await git(root, ['commit', '--no-verify', '-m', 'Mercury safety baseline'], signal);
  }

  async prepare(input: { projectRoot: string; chatId: string; signal?: AbortSignal }): Promise<ProjectWorkspace> {
    if (!input.chatId.trim()) throw new Error('Chat identity is required.');
    const projectRoot = await fs.realpath(input.projectRoot);
    if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error('Project must be a directory.');
    return this.exclusive(projectRoot, async () => {
      aborted(input.signal);
      await this.ensureRepository(projectRoot, input.signal);
      const workspace = { id: this.id(projectRoot, input.chatId), chatId: input.chatId, projectRoot, root: projectRoot, kind: 'direct' as const, serialized: true as const };
      this.baselines.set(workspace.id, await this.snapshotEligible(projectRoot, input.signal));
      return workspace;
    });
  }

  async load(_id: string): Promise<ProjectWorkspace> { throw new Error('Project workspaces are no longer persisted; reopen the project chat.'); }

  /** Commit only safe project files. A clean checkout produces no commit. */
  async commitResponse(workspace: ProjectWorkspace, signal?: AbortSignal): Promise<{ committed: boolean; revision?: string }> {
    return this.exclusive(workspace.projectRoot, async () => {
      aborted(signal);
      await this.ensureRepository(workspace.projectRoot, signal);
      await this.configureIdentity(workspace.projectRoot, signal);
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
