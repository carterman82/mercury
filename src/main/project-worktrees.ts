import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ProjectWorkspace {
  id: string;
  chatId: string;
  projectRoot: string;
  root: string;
  kind: 'git-worktree' | 'direct';
  /** Direct folders must have one writer; worktrees may run independently. */
  serialized: boolean;
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
interface Manifest {
  version: 1;
  workspace: ProjectWorkspace;
  revision: number;
  baseline: Record<string, string>;
  baselineModes: Record<string, number>;
}
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.vite', '.next', 'coverage', '.cache', '__pycache__']);
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const fileMode = async (root: string, relative: string) => (await fs.stat(await safePath(root, relative))).mode & 0o777;
const maxFileBytes = 64 * 1024 * 1024;
const maxSnapshotBytes = 256 * 1024 * 1024;

function eligible(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return !parts.some(part => excludedDirectories.has(part.toLowerCase()))
    && !parts.some(part => /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(part))
    && !/\.(?:pem|p12|pfx|key)$/i.test(relative);
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-C', root, ...args], { signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
async function safePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('Invalid workspace path.');
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error('Path escapes workspace.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`Linked paths are unsupported: ${relative}`);
    if (stat && !within(root, await fs.realpath(current))) throw new Error('Path follows a link outside workspace.');
  }
  return target;
}
async function readFile(root: string, relative: string): Promise<Buffer | null> {
  const target = await safePath(root, relative);
  const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > maxFileBytes) throw new Error(`Unsupported or oversized workspace file: ${relative}`);
  return fs.readFile(target);
}

/** Storage belongs in application data, outside every source project. Never deletes worktrees. */
export class ProjectWorktreeService {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(readonly storageRoot: string) {}

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(key, next);
    try { return await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
  private directory(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid workspace identity.');
    return path.join(this.storageRoot, id);
  }
  private async persist(manifest: Manifest): Promise<void> {
    const target = path.join(this.directory(manifest.workspace.id), 'workspace.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(manifest), { flag: 'wx' });
    await fs.rename(temporary, target);
  }
  private async manifest(id: string): Promise<Manifest> {
    const value: Manifest = JSON.parse(await fs.readFile(path.join(this.directory(id), 'workspace.json'), 'utf8'));
    if (value.version !== 1 || value.workspace.id !== id || !value.baseline || !Number.isInteger(value.revision)) throw new Error('Invalid workspace metadata.');
    const expectedRoot = value.workspace.kind === 'direct' ? value.workspace.projectRoot : path.join(this.directory(id), 'checkout');
    if (value.workspace.root !== expectedRoot) throw new Error('Invalid workspace ownership.');
    if (await fs.realpath(value.workspace.projectRoot) !== value.workspace.projectRoot) throw new Error('Project folder identity changed.');
    return value;
  }
  async load(id: string): Promise<ProjectWorkspace> { return (await this.manifest(id)).workspace; }

  async prepare(input: { projectRoot: string; chatId: string; signal?: AbortSignal }): Promise<ProjectWorkspace> {
    if (!input.chatId.trim()) throw new Error('Chat identity is required.');
    const projectRoot = await fs.realpath(input.projectRoot);
    if (!(await fs.stat(projectRoot)).isDirectory()) throw new Error('Project must be a directory.');
    await fs.mkdir(this.storageRoot, { recursive: true });
    const storage = await fs.realpath(this.storageRoot);
    if (within(projectRoot, storage) || within(storage, projectRoot)) throw new Error('Workspace storage must be separate from the project.');
    const identityRoot = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
    const id = digest(`${identityRoot}\0${input.chatId}`);
    return this.exclusive(id, async () => {
      aborted(input.signal);
      try { return await this.load(id); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      let repository = false;
      try {
        const top = await fs.realpath((await git(projectRoot, ['rev-parse', '--show-toplevel'], input.signal)).trim());
        if (top !== projectRoot) throw new Error('Choose the repository root, not a nested folder.');
        repository = true;
      } catch (error: any) {
        aborted(input.signal);
        if (!String(error.stderr ?? error.message).includes('not a git repository')) throw error;
      }
      const directory = this.directory(id);
      await fs.mkdir(directory, { recursive: true });
      const workspace: ProjectWorkspace = { id, chatId: input.chatId, projectRoot, root: repository ? path.join(directory, 'checkout') : projectRoot, kind: repository ? 'git-worktree' : 'direct', serialized: !repository };
      const manifest: Manifest = { version: 1, workspace, revision: 0, baseline: {}, baselineModes: {} };
      if (repository) {
        // A cancelled/failed preparation preserves its checkout for recovery rather than deleting files.
        if (await fs.stat(workspace.root).then(() => true, () => false)) throw new Error('Incomplete workspace preparation found; recover its files before retrying.');
        const source = await this.snapshot(projectRoot, input.signal);
        await git(projectRoot, ['worktree', 'add', '--detach', '--no-checkout', workspace.root, 'HEAD'], input.signal);
        await git(workspace.root, ['read-tree', 'HEAD'], input.signal);
        await fs.mkdir(path.join(directory, 'blobs'), { recursive: true });
        for (const [relative, content] of source) {
          aborted(input.signal);
          const mode = await fileMode(projectRoot, relative);
          await this.write(workspace.root, relative, content, mode);
          const hash = digest(content);
          await fs.writeFile(path.join(directory, 'blobs', hash), content);
          manifest.baseline[relative] = hash;
          manifest.baselineModes[relative] = mode;
        }
      }
      aborted(input.signal);
      await this.persist(manifest);
      return workspace;
    });
  }

  private async snapshot(root: string, signal?: AbortSignal): Promise<Map<string, Buffer>> {
    const names = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)).split('\0');
    const result = new Map<string, Buffer>();
    let bytes = 0;
    for (const relative of [...new Set(names)].filter(name => name && eligible(name)).sort()) {
      aborted(signal);
      const content = await readFile(root, relative);
      if (!content) continue;
      bytes += content.length;
      if (bytes > maxSnapshotBytes) throw new Error('Workspace baseline exceeds the 256 MB capture limit.');
      result.set(relative, content);
    }
    return result;
  }
  private async reviewManifest(manifest: Manifest): Promise<{ review: ProjectWorkspaceReview; snapshot: Map<string, Buffer> }> {
    if (manifest.workspace.kind !== 'git-worktree') throw new Error('Direct folders use serialized edits, not worktree integration.');
    const snapshot = await this.snapshot(manifest.workspace.root);
    const changes: ProjectWorkspaceChange[] = [];
    for (const relative of [...new Set([...Object.keys(manifest.baseline), ...snapshot.keys()])].sort()) {
      const beforeHash = manifest.baseline[relative] ?? null;
      const content = snapshot.get(relative) ?? null;
      const afterHash = content ? digest(content) : null;
      const beforeMode = manifest.baselineModes[relative] ?? null;
      const afterMode = content ? await fileMode(manifest.workspace.root, relative) : null;
      if (beforeHash === afterHash && beforeMode === afterMode) continue;
      const before = beforeHash ? await fs.readFile(path.join(this.directory(manifest.workspace.id), 'blobs', beforeHash)) : null;
      const binary = Boolean(before?.includes(0) || content?.includes(0));
      const preview = (buffer: Buffer | null) => buffer && !binary ? buffer.toString('utf8').slice(0, 100_000) : null;
      changes.push({ path: relative, beforeHash, afterHash, beforeMode, afterMode, before: preview(before), after: preview(content), binary });
    }
    const token = digest(JSON.stringify([manifest.workspace.id, manifest.revision, changes.map(change => [change.path, change.beforeHash, change.afterHash, change.beforeMode, change.afterMode])]));
    return { review: { workspace: manifest.workspace, token, changes }, snapshot };
  }
  async review(id: string): Promise<ProjectWorkspaceReview> { return (await this.reviewManifest(await this.manifest(id))).review; }

  /** Caller authorizes this exact token. Source modifications on touched files always stop integration. */
  async integrate(id: string, token: string, signal?: AbortSignal): Promise<ProjectWorkspaceReview> {
    const initial = await this.manifest(id);
    return this.exclusive(initial.workspace.projectRoot, () => this.exclusive(id, async () => {
      const manifest = await this.manifest(id);
      const { review, snapshot } = await this.reviewManifest(manifest);
      if (token !== review.token) throw new Error('Worktree changed after review. Review again.');
      const originals = new Map<string, Buffer | null>();
      for (const change of review.changes) {
        aborted(signal);
        const original = await readFile(manifest.workspace.projectRoot, change.path);
        if ((original ? digest(original) : null) !== change.beforeHash || (original ? await fileMode(manifest.workspace.projectRoot, change.path) : null) !== change.beforeMode) throw new Error(`Project changed since baseline: ${change.path}`);
        originals.set(change.path, original);
      }
      const applied: string[] = [];
      try {
        for (const change of review.changes) {
          aborted(signal);
          // Recheck just before replacement, including links introduced after review.
          const original = await readFile(manifest.workspace.projectRoot, change.path);
          if ((original ? digest(original) : null) !== change.beforeHash || (original ? await fileMode(manifest.workspace.projectRoot, change.path) : null) !== change.beforeMode) throw new Error(`Project changed during integration: ${change.path}`);
          await this.write(manifest.workspace.projectRoot, change.path, snapshot.get(change.path) ?? null, change.afterMode ?? undefined);
          applied.push(change.path);
        }
      } catch (error) {
        for (const relative of applied.reverse()) {
          const current = await readFile(manifest.workspace.projectRoot, relative);
          const intended = snapshot.get(relative) ?? null;
          if ((current ? digest(current) : null) === (intended ? digest(intended) : null)) await this.write(manifest.workspace.projectRoot, relative, originals.get(relative) ?? null, manifest.baselineModes[relative]);
        }
        throw error;
      }
      for (const change of review.changes) {
        const content = snapshot.get(change.path);
        if (content) {
          manifest.baseline[change.path] = digest(content);
          manifest.baselineModes[change.path] = change.afterMode!;
          await fs.writeFile(path.join(this.directory(id), 'blobs', digest(content)), content);
        } else { delete manifest.baseline[change.path]; delete manifest.baselineModes[change.path]; }
      }
      manifest.revision += 1;
      await this.persist(manifest);
      return review;
    }));
  }
  private async write(root: string, relative: string, content: Buffer | null, mode?: number): Promise<void> {
    const target = await safePath(root, relative);
    if (content === null) { await fs.unlink(target); return; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.mercury-tmp`;
    try {
      await fs.writeFile(temporary, content, { flag: 'wx' });
      if (mode !== undefined) await fs.chmod(temporary, mode);
      await safePath(root, relative);
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
