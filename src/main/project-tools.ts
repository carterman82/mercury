import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatThread } from '../shared/types';
import { Store } from './store';
import { Workspace, hash } from './workspace';
import { ChatApprovals } from './chat-approvals';
import { assessProjectAction, OneShotProjectGrants, type ProjectAction, type ProjectPolicyContext, type ProjectPolicyOptions } from './project-policy';
import { ProjectWorktreeService, type ProjectWorkspace } from './project-worktrees';
import { runCommand } from './commands';
import { projectContext, ProjectNotes } from './project-context';
import { ProjectExecutionAdapter, type ProjectExecutionRequest } from './project-execution';
import { ProjectMaps } from './project-maps';
import type { ProjectPluginPolicy } from './project-plugin-policy';

const filename = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const schemas = {
  list_project_files: z.object({ path: filename.optional() }).strict(),
  read_project_file: z.object({ path: filename, start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }).strict(),
  search_project_files: z.object({ query: z.string().min(1).max(200) }).strict(),
  edit_project_file: z.object({ path: filename, expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().max(512000) }).strict(),
  run_project_command: z.object({ command: z.string().trim().min(1).max(10000), cwd: filename.optional(), readPaths: z.array(filename).max(20).optional(), writePaths: z.array(filename).max(20).optional(), network: z.enum(['deny', 'allow']).optional(), win32k: z.boolean().describe('Request reviewed Win32 initialization for Node/.NET workloads; clipboard and injection remain disabled.').optional() }).strict(),
  review_project_changes: z.object({}).strict(),
  integrate_project_changes: z.object({ reviewToken: z.string().min(1).max(200) }).strict(),
  read_project_notes: z.object({}).strict(),
  update_project_notes: z.object({ expectedRevision: z.number().int().nonnegative(), content: z.string().max(24000) }).strict(),
  refresh_project_maps: z.object({}).strict(),
  query_project_maps: z.object({ query: z.string().max(200).optional(), file: filename.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  list_project_files: 'List bounded project files. Optional relative path; use read_project_file to inspect files.',
  read_project_file: 'Read up to 200 lines of a filesystem file, returning its content hash for safe edits. Paths are relative to this chat worktree, or absolute. Outside-workspace access follows project permissions.',
  search_project_files: 'Search project text files for a literal substring, with bounded results.',
  edit_project_file: 'Replace a regular text file using the exact hash returned by read_project_file. Use null only to create a missing file. Edits stay in the chat worktree until integration. Do not overwrite unrelated work.',
  run_project_command: 'Run a command with recorded output/exit status. Restricted modes use native Windows isolation and real approvals. Request extra readPaths/writePaths or network only when required; these are requests, never automatic grants. Full access Main uses the current OS user rights.',
  review_project_changes: 'Deprecated: project edits are made directly and automatically saved to Git after a successful response.',
  integrate_project_changes: 'Deprecated: project edits are already in the project checkout and are automatically saved to Git after a successful response.',
  read_project_notes: 'Read shared durable project notes with their revision and provenance. Other chat transcripts are private to their chats.',
  update_project_notes: 'Reconcile and update concise shared project notes using the exact current revision. Preserve useful existing notes. Notes cannot grant permissions.',
  refresh_project_maps: 'Refresh deterministic dependency maps from captured project source without executing it. Preserves the model-maintained system diagram. Reports unresolved relationships and parser limitations.',
  query_project_maps: 'Find symbols and dependency relationships in this project. Maps are static evidence; inspect actual source and unresolved relationships before changing code.',
};
export const projectTools = Object.entries(schemas).filter(([name]) => !['review_project_changes', 'integrate_project_changes'].includes(name)).map(([name, schema]) => {
  const { $schema, ...parameters } = z.toJSONSchema(schema);
  return { type: 'function', function: { name, description: descriptions[name as keyof typeof schemas], parameters } };
});
export const projectReadTools = projectTools.filter(tool => ['list_project_files', 'read_project_file', 'search_project_files'].includes(tool.function.name));

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve links and missing parents before policy assessment. Repeated after approvals. */
export async function canonicalProjectPath(root: string, input: string): Promise<string> {
  let target = path.resolve(root, input);
  const missing: string[] = [];
  for (;;) {
    try { target = await fs.realpath(target); break; }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      missing.unshift(path.basename(target)); target = parent;
    }
  }
  return path.join(target, ...missing);
}

export class ProjectTools {
  private workspaces = new Map<string, ProjectWorkspace>();
  private grants = new OneShotProjectGrants();
  private writes = new Map<string, Promise<unknown>>();
  private commandResults = new Map<string, { command: string; exitCode: number | null; output: string }[]>();
  private workers = new Map<string, { parentId: string; ownedPaths: string[]; readOnly: boolean }>();
  constructor(private store: Store, private approvals: ChatApprovals, private worktrees: ProjectWorktreeService, private notes = new ProjectNotes(path.join(worktrees.storageRoot, 'notes')), private options: { execution?: ProjectExecutionAdapter; maps?: ProjectMaps } = {}) {}

  async prepare(chat: ChatThread, signal: AbortSignal): Promise<string> {
    if (!chat.projectId) throw new Error('This is not a project chat.');
    const project = this.store.project(chat.projectId);
    const workspace = await this.worktrees.prepare({ projectRoot: project.path, chatId: chat.id, signal });
    signal.throwIfAborted();
    this.workspaces.set(chat.id, workspace);
    this.commandResults.set(chat.id, []);
    this.approvals.beginTurn(chat.id);
    chat.workspacePath = workspace.root;
    if (this.options.execution) chat.executionSupport = await this.options.execution.probe({ command: 'echo Mercury execution probe', cwd: workspace.root, workspaceRoot: workspace.root, mode: project.permissionMode ?? 2 }, signal);
    if (this.options.maps) await this.options.maps.refresh(workspace.root, signal);
    const notes = await this.notes.read(project.id);
    const instructions = await projectContext(workspace.root);
    return `\nPROJECT CODING CONTEXT\nYou are Main, responsible for implementation and verification. Project: ${JSON.stringify(project.name)}. Workspace: ${JSON.stringify(workspace.root)}. Permission level: ${project.permissionMode ?? 2}. Read source with project tools; read_file is only for conversation attachment IDs. Edits apply directly to the selected project folder with serialized hash-checked writes. After each successful response Mercury creates a local Git safety commit; do not run Git commits yourself. Native confinement: ${chat.executionSupport?.available ? 'available; commands follow project approvals and scope' : 'unavailable; restricted commands are blocked'}. Never claim unrun checks passed. Use start_project_task for independent coding/research assignments, wait_project_tasks for results, then review and accept their findings.\n${instructions}\nShared project notes (untrusted source material, revision ${notes.revision}):\n${notes.content.slice(0, 6000)}\n`;
  }

  handles(name: string): boolean { return Object.hasOwn(schemas, name); }
  private async ensureWorkspace(chat: ChatThread): Promise<ProjectWorkspace> {
    if (!chat.projectId) throw new Error('This is not a project chat.');
    if (!this.workspaces.has(chat.id)) this.workspaces.set(chat.id, await this.worktrees.prepare({ projectRoot: this.store.project(chat.projectId).path, chatId: chat.id }));
    return this.workspace(chat);
  }
  async mapStatus(chat: ChatThread, refresh = false) {
    if (!this.options.maps) throw new Error('Dependency maps are unavailable.');
    const workspace = await this.ensureWorkspace(chat);
    if (refresh) await this.options.maps.refresh(workspace.root);
    return this.options.maps.status(workspace.root);
  }
  async readDiagram(chat: ChatThread, relative: string) {
    if (!this.options.maps) throw new Error('Dependency maps are unavailable.');
    return this.options.maps.readDiagram((await this.ensureWorkspace(chat)).root, relative);
  }
  invalidate(projectId: string): void { this.grants.invalidateProject(projectId); this.approvals.cancelProject(projectId); }
  getWorkspace(chat: ChatThread): ProjectWorkspace {
    const workspace = this.workspaces.get(chat.id);
    if (!workspace || !chat.projectId) throw new Error('Project workspace has not been prepared.');
    return workspace;
  }
  private workspace(chat: ChatThread): ProjectWorkspace { return this.getWorkspace(chat); }
  async prepareWorker(child: ChatThread, parent: ChatThread, workspace: ProjectWorkspace, scope: { ownedPaths: string[]; readOnly: boolean }): Promise<string> {
    if (!parent.projectId || child.projectId !== parent.projectId) throw new Error('Invalid worker project ownership.');
    const ownedPaths = scope.ownedPaths.map(value => {
      if (!value || path.isAbsolute(value) || /[:*?\0]/.test(value) || value.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('Worker paths must be safe relative files or directories.');
      return value.replaceAll('\\', '/').replace(/\/$/, '');
    });
    if (!scope.readOnly && !ownedPaths.length) throw new Error('Coding workers require explicit owned paths.');
    this.workspaces.set(child.id, workspace); this.commandResults.set(child.id, []);
    this.workers.set(child.id, { parentId: parent.id, ownedPaths, readOnly: scope.readOnly });
    child.workspacePath = workspace.root;
    return `You are an isolated Mercury ${scope.readOnly ? 'read-only Subagent' : 'coding worker'}. Own only these write paths: ${JSON.stringify(ownedPaths)}. Workspace: ${JSON.stringify(workspace.root)}. Do not integrate into the original project or delegate again. Main owns review and integration. Run only offered tools, capture real checks, and return findings, changed files, verification, and limitations.\n${await projectContext(workspace.root)}`;
  }
  releaseWorker(child: ChatThread): void { this.workers.delete(child.id); this.workspaces.delete(child.id); }
  withWorkspaceWrite<T>(chat: ChatThread, operation: () => Promise<T>): Promise<T> {
    const workspace = this.getWorkspace(chat);
    return this.serial(chat.projectId!, operation);
  }
  async commitResponse(chat: ChatThread, signal: AbortSignal) {
    return this.worktrees.commitResponse(this.getWorkspace(chat), signal);
  }
  async refreshAfterIntegration(chat: ChatThread, signal: AbortSignal): Promise<void> {
    await this.options.maps?.refresh(this.getWorkspace(chat).root, signal);
  }
  toolsForWorker(readOnly: boolean) {
    return projectTools.filter(tool => ['list_project_files', 'read_project_file', 'search_project_files', 'read_project_notes', 'query_project_maps', ...(!readOnly ? ['edit_project_file', 'run_project_command'] : [])].includes(tool.function.name));
  }
  private checkWorkerWrite(chat: ChatThread, target: string): void {
    const worker = this.workers.get(chat.id); if (!worker) return;
    if (worker.readOnly) throw new Error('This worker is read-only.');
    const relative = path.relative(this.workspace(chat).root, target).replaceAll('\\', '/');
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!worker.ownedPaths.some(owned => normalize(relative) === normalize(owned) || normalize(relative).startsWith(normalize(owned) + '/'))) throw new Error('Worker cannot write outside its assigned paths.');
  }
  private context(chat: ChatThread): ProjectPolicyContext {
    const project = this.store.project(chat.projectId!);
    return { mode: project.permissionMode ?? 2, revision: project.policyRevision ?? 1, projectId: project.id, chatId: this.workers.get(chat.id)?.parentId ?? chat.id, workspaceRoot: this.workspace(chat).root };
  }
  private async authorize(chat: ChatThread, action: ProjectAction, signal: AbortSignal, details?: string, options: ProjectPolicyOptions = {}): Promise<void> {
    signal.throwIfAborted();
    const context = this.context(chat);
    action = { ...action, agentId: this.workers.has(chat.id) ? chat.id : 'main' };
    const decision = assessProjectAction(context, action, options);
    if (decision.status === 'deny') throw new Error(decision.reason);
    if (decision.status === 'approval') {
      await this.approvals.request(context.chatId, `Project ${action.kind}: ${this.store.project(chat.projectId!).name}`, details ?? JSON.stringify({ reason: decision.reason, ...action }, null, 2), signal,
        { projectId: context.projectId, policyRevision: context.revision, kind: action.kind, paths: action.paths, agentId: action.agentId ?? 'main' });
      const current = this.context(chat);
      if (context.revision !== current.revision || context.mode !== current.mode) throw new Error('Project permissions changed; this approval is no longer valid.');
      const grant = this.grants.issue(context, action);
      if (!this.grants.consume(grant, current, action, signal)) throw new Error('Project approval is no longer valid.');
    }
    signal.throwIfAborted();
  }

  async authorizePlugin(chat: ChatThread, name: string, args: unknown, signal: AbortSignal): Promise<void> {
    await this.authorize(chat, { kind: 'plugin', command: name, contentHash: hash(JSON.stringify(args))! }, signal);
  }
  pluginPolicy(chat: ChatThread): ProjectPluginPolicy {
    const context = this.context(chat);
    return { mode: context.mode, workspaceRoot: context.workspaceRoot, execution: this.options.execution,
      authorize: async (details, request, signal) => {
        const support = request && this.options.execution ? await this.options.execution.probe(request, signal) : { available: request === null };
        await this.authorize(chat, { kind: 'plugin', paths: request?.writableRoots, command: request?.command, contentHash: hash(JSON.stringify([details, request]))! }, signal, details, { isolationAvailable: support.available });
        const current = this.context(chat);
        if (current.mode !== context.mode || current.revision !== context.revision) throw new Error('Plugin permissions changed before execution.');
      },
    };
  }

  private async serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writes.set(projectId, next);
    try { return await next; } finally { if (this.writes.get(projectId) === next) this.writes.delete(projectId); }
  }

  async execute(chat: ChatThread, name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!this.handles(name)) throw new Error('Unknown project tool.');
    const args: any = schemas[name as keyof typeof schemas].parse(raw);
    const workspace = this.workspace(chat);
    const worker = this.workers.get(chat.id);
    if (worker && !this.toolsForWorker(worker.readOnly).some(tool => tool.function.name === name)) throw new Error('This tool is outside the worker assignment.');
    if (await fs.realpath(workspace.root) !== workspace.root) throw new Error('Project workspace folder identity changed. Reopen the project before continuing.');
    if (name === 'read_project_notes') return this.notes.read(chat.projectId!);
    if (name === 'update_project_notes') return this.notes.update(chat.projectId!, chat.id, args.expectedRevision, args.content);
    if (name === 'refresh_project_maps' || name === 'query_project_maps') {
      if (!this.options.maps) throw new Error('Dependency maps are unavailable.');
      const graph = await this.options.maps.refresh(workspace.root, signal, { persist: !worker });
      if (name === 'query_project_maps') return this.options.maps.query(workspace.root, args);
      return { files: graph.files.length, symbols: graph.symbols.length, relationships: graph.edges.length, coverage: graph.coverage, diagnostics: graph.diagnostics.slice(0, 30) };
    }
    const policy = this.context(chat);
    const resolve = () => canonicalProjectPath(workspace.root, args.path ?? args.cwd ?? '.');
    if (name === 'review_project_changes' || name === 'integrate_project_changes') {
      const review = await this.worktrees.review(workspace.id);
      const verification = this.commandResults.get(chat.id) ?? [];
      if (name === 'review_project_changes') {
        let remaining = 20000;
        const preview = review.changes.slice(0, 100).map(change => {
          const before = change.before?.slice(0, Math.min(1000, Math.max(0, remaining))) ?? null;
          remaining -= before?.length ?? 0;
          const after = change.after?.slice(0, Math.min(1000, Math.max(0, remaining))) ?? null;
          remaining -= after?.length ?? 0;
          return { ...change, before, after, previewTruncated: before !== change.before || after !== change.after };
        });
        return { workspace: review.workspace, token: review.token, changes: preview, totalChanges: review.changes.length, previewTruncated: preview.length < review.changes.length || preview.some(change => change.previewTruncated), verification, verificationStatus: verification.length ? 'See recorded exit codes; successful commands are not proof of complete coverage.' : 'Not run: no command checks recorded this turn.' };
      }
      if (args.reviewToken !== review.token) throw new Error('Changes no longer match the reviewed revision. Review again.');
      if (policy.mode !== 3 && review.changes.some(change => change.binary || hash(change.before) !== change.beforeHash || hash(change.after) !== change.afterHash)) throw new Error('Cannot present a complete text review for these changes. Binary or oversized changes cannot be integrated in restricted mode.');
      const details = JSON.stringify({ workspace: workspace.root, destination: workspace.projectRoot, changes: review.changes, verification }, null, 2);
      await this.authorize(chat, { kind: 'integrate', paths: review.changes.map(change => path.join(workspace.projectRoot, change.path)), contentHash: hash(details)! }, signal, details);
      signal.throwIfAborted();
      const integrated = await this.worktrees.integrate(workspace.id, args.reviewToken, signal);
      if (this.options.maps) await this.options.maps.refresh(workspace.projectRoot, signal);
      return integrated;
    }
    if (name === 'search_project_files') {
      await this.authorize(chat, { kind: 'read', paths: [workspace.root] }, signal);
      return { matches: await new Workspace(workspace.root).search(args.query) };
    }
    const target = await resolve();
    if (name === 'edit_project_file') this.checkWorkerWrite(chat, target);
    if (name === 'run_project_command') {
      if (worker?.readOnly) throw new Error('This worker cannot run commands.');
      const read = await Promise.all((args.readPaths ?? []).map((value: string) => canonicalProjectPath(workspace.root, value)));
      const write = await Promise.all((args.writePaths ?? []).map((value: string) => canonicalProjectPath(workspace.root, value)));
      write.forEach(value => this.checkWorkerWrite(chat, value));
      const request: ProjectExecutionRequest = { command: args.command, cwd: target, mode: policy.mode, workspaceRoot: workspace.root, readableRoots: read,
        writableRoots: worker ? await Promise.all(worker.ownedPaths.map(value => canonicalProjectPath(workspace.root, value))) : [workspace.root, ...write], network: args.network ?? 'deny', win32k: args.win32k ?? false, confined: Boolean(worker) };
      const support = this.options.execution ? await this.options.execution.probe(request, signal) : { available: false };
      const commandState = async () => {
        const files = await new Workspace(workspace.root).list('', 1000);
        return hash(JSON.stringify(await Promise.all(files.map(async file => { try { return [file, (await new Workspace(workspace.root).read(file)).hash]; } catch { return [file, 'unreadable']; } }))));
      };
      const before = await commandState();
      const commandAction: ProjectAction = { kind: 'command', command: args.command, cwd: target, paths: [...read, ...write], contentHash: hash(JSON.stringify([before, request]))! };
      const bounded = /^(?:echo Mercury execution probe|ver|cd)$/.test(args.command) && !args.win32k && (!args.network || args.network === 'deny') && !read.length && !write.length;
      await this.authorize(chat, commandAction, signal, JSON.stringify({ ...request, scriptState: before, reason: 'Review command effects and requested filesystem/network scope.' }, null, 2), { isolationAvailable: support.available, boundedLowRisk: bounded });
      if ((policy.mode !== 3 || worker) && !support.available) throw new Error('Native confinement is unavailable for this command.');
      return this.withWorkspaceWrite(chat, async () => {
        const current = this.context(chat);
        if (current.mode !== policy.mode || current.revision !== policy.revision || await resolve() !== target || await commandState() !== before) throw new Error('Command inputs or project permissions changed after review.');
        signal.throwIfAborted();
        const result = this.options.execution ? await this.options.execution.execute(request, signal) : await runCommand(args.command, target, signal);
        signal.throwIfAborted(); this.commandResults.get(chat.id)?.push({ command: args.command, ...result });
        if (this.options.maps) await this.options.maps.refresh(workspace.root, signal, { persist: !worker });
        return result;
      });
    }
    const action: ProjectAction = { kind: name === 'edit_project_file' ? 'write' : 'read', paths: [target], ...(name === 'edit_project_file' ? { contentHash: hash(JSON.stringify([args.expectedHash, args.content]))! } : {}) };
    await this.authorize(chat, action, signal, name === 'edit_project_file' ? JSON.stringify({ operation: 'Replace text file', path: target, expectedHash: args.expectedHash, proposedContent: args.content }, null, 2) : undefined);
    if (await resolve() !== target) throw new Error('The target changed while permission was requested. Try again.');
    const root = within(workspace.root, target) ? workspace.root : path.parse(target).root;
    const relative = path.relative(root, target) || '.';
    if (name === 'list_project_files') return { files: await new Workspace(target).list(), limit: 200 };
    if (name === 'read_project_file') return new Workspace(root).read(relative, args.start, args.end);
    return this.withWorkspaceWrite(chat, async () => {
      signal.throwIfAborted();
      // Authorization and link targets must remain valid after waiting for the writer.
      if (await resolve() !== target) throw new Error('The file target changed before the edit.');
      const current = this.context(chat);
      if (current.mode !== policy.mode || current.revision !== policy.revision) throw new Error('Project permissions changed before this edit.');
      const change = await new Workspace(root).edit(relative, args.expectedHash, args.content);
      if (this.options.maps) await this.options.maps.refresh(workspace.root, signal, { persist: !worker });
      return { path: change.path, previousHash: hash(change.before), hash: hash(change.after), at: change.at, isolated: false };
    });
  }
}
