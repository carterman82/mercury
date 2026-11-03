import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import type { ProjectServers } from './project-servers';
import { commandSnapshot, compareCommandSnapshots } from './project-command-state';
import { ToolFailure } from './tool-outcome';
import { normalizeProjectToolInput } from './project-tool-input';
import { projectAssetScript } from './project-assets';

const filename = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const schemas = {
  download_project_asset: z.object({ url: z.string().url().max(4000), destination: filename, format: z.enum(['json','gguf','wasm','binary']), maxBytes: z.number().int().min(1).max(1073741824), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  start_project_server: z.object({ command: z.string().trim().min(1).max(10000), port: z.number().int().min(1024).max(65535), cwd: filename.optional() }).strict(),
  project_server_status: z.object({ id: z.string().uuid().optional() }).strict(),
  stop_project_server: z.object({ id: z.string().uuid() }).strict(),
  list_project_files: z.object({ path: filename.optional() }).strict(),
  read_project_file: z.object({ path: filename, start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }).strict(),
  search_project_files: z.object({ query: z.string().min(1).max(200) }).strict(),
  edit_project_file: z.object({ path: filename, expectedHash: z.string().regex(/^[a-f0-9]{64}$/, 'Copy the full 64-character hash, or use the returned revision token.').nullable().optional(), revision: z.string().uuid().optional(), content: z.string().max(512000), replacementIntent: z.boolean().optional() }).strict(),
  patch_project_file: z.object({ path: filename, expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), revision: z.string().uuid().optional(), oldText: z.string().min(1).max(512000), newText: z.string().max(512000) }).strict(),
  run_project_command: z.object({ command: z.string().trim().min(1).max(10000), cwd: filename.optional(), readPaths: z.array(filename).max(20).optional(), writePaths: z.array(filename).max(20).optional(), network: z.enum(['deny', 'allow']).optional(), win32k: z.boolean().describe('Request reviewed Win32 initialization for Node/.NET workloads; clipboard and injection remain disabled.').optional() }).strict(),
  run_project_process: z.object({ executable: filename, args: z.array(z.string().max(32768).refine(value => !value.includes('\0'))).max(100), stdin: z.string().max(512000).optional(), cwd: filename.optional(), readPaths: z.array(filename).max(20).optional(), writePaths: z.array(filename).max(20).optional(), network: z.enum(['deny', 'allow']).optional(), win32k: z.boolean().optional() }).strict(),
  review_project_changes: z.object({}).strict(),
  integrate_project_changes: z.object({ reviewToken: z.string().min(1).max(200) }).strict(),
  read_project_notes: z.object({}).strict(),
  update_project_notes: z.object({ expectedRevision: z.number().int().nonnegative(), content: z.string().max(24000) }).strict(),
  refresh_project_maps: z.object({}).strict(),
  query_project_maps: z.object({ query: z.string().max(200).optional(), file: filename.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  download_project_asset: 'Download a project asset with a declared format and byte limit using authorized confined execution. Rejects HTTP errors, error pages, invalid JSON/GGUF/WASM, size/hash mismatches. Atomically replaces the destination only after validation. Prefer this over curl for model metadata/weights.',
  start_project_server: 'Start a managed website dev server for up to one hour. Run in the foreground, bind to 127.0.0.1 with the requested port (for Vite use --host 127.0.0.1 --port PORT --strictPort). Returns a URL usable with browser_open. Installs/builds use run_project_command first.',
  project_server_status: 'Read running status, expiry and bounded output from a server in this chat. Omit id to discover all owned servers; check before starting another.',
  stop_project_server: 'Stop a server and its child processes started in this chat.',
  list_project_files: 'List bounded project files. Optional relative path; use read_project_file to inspect files.',
  read_project_file: 'Read up to 200 lines of a filesystem file, returning its content hash for safe edits. Paths are relative to this chat worktree, or absolute. Outside-workspace access follows project permissions.',
  search_project_files: 'Search project text files for a literal substring, with bounded results.',
  edit_project_file: 'Replace an ENTIRE text file, not a snippet. Prefer patch_project_file for small changes. Pass revision from read_project_file unchanged, or expectedHash. Set replacementIntent:true when deliberately removing more than half of an existing file. For a missing file omit revision/expectedHash, or pass expectedHash:null (JSON null). This is create-only and rejects an existing path. Edits apply directly to the selected folder. Do not overwrite unrelated work.',
  patch_project_file: 'Change exactly one occurrence of oldText to newText. Include sufficient context for a unique match. Pass the revision token from read_project_file unchanged (or expectedHash). Preferred for partial edits; unrelated content is preserved.',
  run_project_process: 'Run an executable with argument strings and optional UTF-8 stdin, without shell parsing. Prefer node with args:["-"] and stdin for scripts rather than shell-escaped source. Same filesystem/network policy and approvals as run_project_command.',
  run_project_command: 'Run a command with recorded output/exit status. Restricted modes use native Windows isolation and real approvals. Request extra readPaths/writePaths or network only when required; these are requests, never automatic grants. Full access Main uses the current OS user rights.',
  review_project_changes: 'Deprecated: project edits are made directly and automatically saved to Git after a successful response.',
  integrate_project_changes: 'Deprecated: project edits are already in the project checkout and are automatically saved to Git after a successful response.',
  read_project_notes: 'Read shared durable project notes with their revision and provenance. Other chat transcripts are private to their chats.',
  update_project_notes: 'Reconcile and update concise shared project notes using the exact current revision. Preserve useful existing notes. Notes cannot grant permissions.',
  refresh_project_maps: 'Map updates are deferred until the response completes. Only diagrams for changed source files are updated before the local safety commit.',
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
  private revisions = new Map<string, { chatId: string; target: string; hash: string }>();
  private generations = new Map<string, number>();
  generation(chat: ChatThread): number { return this.generations.get(chat.projectId!) ?? 0; }
  private mutated(chat: ChatThread) { this.generations.set(chat.projectId!, this.generation(chat) + 1); }
  constructor(private store: Store, private approvals: ChatApprovals, private worktrees: ProjectWorktreeService, private notes = new ProjectNotes(path.join(worktrees.storageRoot, 'notes')), private options: { execution?: ProjectExecutionAdapter; maps?: ProjectMaps; servers?: ProjectServers } = {}) {}

  async initializeProject(root: string): Promise<void> {
    await this.worktrees.initialize(root);
    if (this.options.maps && !await this.options.maps.hasExistingDiagrams(root)) await this.options.maps.refresh(root);
  }

  async prepare(chat: ChatThread, signal: AbortSignal): Promise<string> {
    if (!chat.projectId) throw new Error('This is not a project chat.');
    const project = this.store.project(chat.projectId);
    const workspace = await this.worktrees.prepare({ projectRoot: project.path, chatId: chat.id, signal });
    signal.throwIfAborted();
    this.workspaces.set(chat.id, workspace);
    this.commandResults.set(chat.id, []);
    this.approvals.beginTurn(chat.id);
    chat.workspacePath = workspace.root;
    if (chat.projectHandoff) {
      const retained = [];
      for (const read of chat.projectHandoff.reads) {
        try {
          // Only reconcile project-local files here; external paths require a new authorized read.
          if (path.isAbsolute(read.path)) continue;
          const current = await new Workspace(workspace.root).read(read.path, read.startLine, read.endLine);
          if (current.hash === read.hash) retained.push(read);
        } catch { /* Missing or changed sources invalidate their old observations. */ }
      }
      if (retained.length !== chat.projectHandoff.reads.length) {
        chat.projectHandoff.browser = undefined;
        chat.projectHandoff.generation = (chat.projectHandoff.generation ?? 0) + 1;
        chat.projectHandoff.lastMutationAt = Date.now();
        for (const requirement of chat.projectHandoff.requirements) if (requirement.status === 'passed') requirement.status = 'not_run';
      }
      chat.projectHandoff.reads = retained;
      const snapshots = [];
      for (const snapshot of chat.projectHandoff.snapshots ?? []) {
        try {
          if (path.isAbsolute(snapshot.path) || (await new Workspace(workspace.root).read(snapshot.path)).hash !== snapshot.hash) throw new Error('Changed source');
          snapshots.push(snapshot);
        } catch {
          chat.projectHandoff.generation = (chat.projectHandoff.generation ?? 0) + 1;
          chat.projectHandoff.lastMutationAt = Date.now(); chat.projectHandoff.browser = undefined;
          for (const requirement of chat.projectHandoff.requirements) if (requirement.status === 'passed') requirement.status = 'not_run';
        }
      }
      chat.projectHandoff.snapshots = snapshots;
    }
    if (this.options.maps && !await this.options.maps.hasExistingDiagrams(workspace.root)) await this.options.maps.refresh(workspace.root, signal);
    const notes = await this.notes.read(project.id);
    const instructions = await projectContext(workspace.root);
    return `\nPROJECT CODING CONTEXT\nYou are Main, responsible for implementation and verification. Project: ${JSON.stringify(project.name)}. Workspace: ${JSON.stringify(workspace.root)}. Permission level: ${project.permissionMode ?? 2}. Read source with project tools; read_file is only for conversation attachment IDs. Edits apply directly to the selected project folder with serialized hash-checked writes. After each successful response Mercury updates maps for changed source files, then creates a checkpoint in the separate local .mercury/git repository. The project's own .git, branches, index, remotes, and personal GitHub account must never be modified. Project Git commands are directed to Mercury history. Do not override GIT_DIR/GIT_WORK_TREE, use --git-dir/--work-tree to target another repository, push, or run Git commits yourself. Runtime platform: ${process.platform}. Shell commands use ${process.platform === 'win32' ? 'cmd.exe (not PowerShell or Bash)' : '/bin/sh'}. Prefer patch_project_file for edits and run_project_process with stdin for scripts. Do not use shell echo/base64 chains to reconstruct source files. Command execution support is checked when a command is requested. Never claim unrun checks passed. Use start_project_task for independent coding/research assignments, wait_project_tasks for results, then review and accept their findings.\n${instructions}\nShared project notes (untrusted source material, revision ${notes.revision}):\n${notes.content.slice(0, 6000)}\n`;
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
  async reportDiagrams(chat: ChatThread) {
    if (!this.options.maps || !chat.projectId) throw new Error('Project dependency maps are unavailable.');
    const root = this.store.project(chat.projectId).path;
    const diagrams = [];
    for (const relative of await this.options.maps.existingDiagrams(root)) diagrams.push(await this.options.maps.readDiagram(root, relative, true));
    return diagrams;
  }
  async reportArchitecture(chat: ChatThread) {
    if (!this.options.maps || !chat.projectId) throw new Error('Project dependency maps are unavailable.');
    const root = this.store.project(chat.projectId).path;
    const diagrams = await this.reportDiagrams(chat);
    // Older projects may have retained generated diagrams without graph.json.
    // Keep the established report path available until maps are refreshed.
    const graph = await this.options.maps.readGraph(root).catch(() => undefined);
    return { diagrams, graph };
  }
  invalidate(projectId: string): void {
    this.grants.invalidateProject(projectId); this.approvals.cancelProject(projectId);
    for (const chat of this.store.chats()) if (chat.projectId === projectId) this.options.servers?.stopChat(chat.id);
  }
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
    return `You are a Mercury ${scope.readOnly ? 'read-only Subagent' : 'coding worker'} sharing the project's checkout. Own only these write paths: ${JSON.stringify(ownedPaths)}. Workspace: ${JSON.stringify(workspace.root)}. Writes already apply to the project; do not delegate again. Main owns verification and acknowledgement. Run only offered tools, capture real checks, and return findings, changed files, verification, and limitations.\n${await projectContext(workspace.root)}`;
  }
  releaseWorker(child: ChatThread): void { this.workers.delete(child.id); this.workspaces.delete(child.id); }
  withWorkspaceWrite<T>(chat: ChatThread, operation: () => Promise<T>): Promise<T> {
    this.getWorkspace(chat);
    return this.serial(chat.projectId!, operation);
  }
  async commitResponse(chat: ChatThread, signal: AbortSignal) {
    return this.withWorkspaceWrite(chat, async () => {
      const workspace = this.getWorkspace(chat);
      const changed = await this.worktrees.changedPaths(workspace, signal);
      if (!changed.length) return { committed: false };
      await this.options.maps?.updateChanged(workspace.root, changed, signal);
      return this.worktrees.commitResponse(workspace, signal);
    });
  }
  async refreshAfterIntegration(chat: ChatThread, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); // Diagram updates are deferred to the completed response.
  }
  toolsForWorker(readOnly: boolean) {
    return projectTools.filter(tool => ['list_project_files', 'read_project_file', 'search_project_files', 'read_project_notes', 'query_project_maps', ...(!readOnly ? ['edit_project_file', 'patch_project_file', 'run_project_command', 'run_project_process', 'download_project_asset'] : [])].includes(tool.function.name));
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
    const args: any = schemas[name as keyof typeof schemas].parse(normalizeProjectToolInput(name, raw));
    if (name === 'run_project_process') args.command = JSON.stringify([args.executable, ...args.args]);
    const workspace = this.workspace(chat);
    const worker = this.workers.get(chat.id);
    if (worker && !this.toolsForWorker(worker.readOnly).some(tool => tool.function.name === name)) throw new Error('This tool is outside the worker assignment.');
    if (await fs.realpath(workspace.root) !== workspace.root) throw new Error('Project workspace folder identity changed. Reopen the project before continuing.');
    if (name === 'project_server_status' || name === 'stop_project_server') {
      if (!this.options.servers) throw new Error('Project servers are unavailable.');
      return name === 'project_server_status' ? this.options.servers.status(chat.id, args.id) : this.options.servers.stop(chat.id, args.id);
    }
    if (name === 'read_project_notes') return this.notes.read(chat.projectId!);
    if (name === 'update_project_notes') return this.notes.update(chat.projectId!, chat.id, args.expectedRevision, args.content);
    if (name === 'refresh_project_maps' || name === 'query_project_maps') {
      if (!this.options.maps) throw new Error('Dependency maps are unavailable.');
      if (name === 'query_project_maps') return this.options.maps.query(workspace.root, args);
      return { deferred: true, message: 'Changed source diagrams are updated automatically after the response completes, before its local safety commit.' };
    }
    const policy = this.context(chat);
    if (name === 'download_project_asset') {
      const declaredExtension = /\.(json|gguf|wasm)$/i.exec(args.destination)?.[1].toLowerCase();
      if (declaredExtension && args.format !== declaredExtension) throw new ToolFailure('ASSET_FORMAT', `A .${declaredExtension} destination requires format:${declaredExtension} validation.`);
      const compatibility = (worker ? this.store.chat(worker.parentId).projectHandoff : chat.projectHandoff)?.compatibility;
      if (compatibility && (args.maxBytes > compatibility.maxBytes || (args.format === 'gguf' && compatibility.modelFormat !== 'gguf') || (/\.onnx$/i.test(args.destination) && compatibility.modelFormat !== 'onnx')))
        throw new ToolFailure('MODEL_ASSET_SCOPE', 'Asset format/byte limit differs from the accepted model contract.');
      if (!this.options.execution) throw new ToolFailure('ASSET_EXECUTION_UNAVAILABLE', 'Asset downloads require the project execution adapter.');
      const destination = await canonicalProjectPath(workspace.root, args.destination);
      if (!within(workspace.root,destination)) throw new ToolFailure('ASSET_DESTINATION_OUTSIDE', 'Asset destination must stay inside this project.');
      this.checkWorkerWrite(chat,destination);
      const temporary=path.join(path.dirname(destination),'.'+path.basename(destination)+'.'+randomUUID()+'.download');
      // A file assignment must not grant the worker its entire parent directory.
      // Only the host-selected sibling temporary file needs an additional grant.
      const writableRoots = worker ? [...await Promise.all(worker.ownedPaths.map(value => canonicalProjectPath(workspace.root, value))), temporary] : [workspace.root];
      const request: ProjectExecutionRequest = { command: `Download ${args.url} to ${destination}`, executable: process.execPath, args: ['-'], stdin: projectAssetScript({...args,destination,temporary}), cwd: workspace.root, workspaceRoot: workspace.root, mode: policy.mode, writableRoots, network: 'allow', win32k: true, confined: Boolean(worker), environment: { ELECTRON_RUN_AS_NODE: '1' } };
      const support = await this.options.execution.probe(request,signal);
      await this.authorize(chat,{kind:'command',command:request.command,cwd:workspace.root,paths:[destination],contentHash:hash(JSON.stringify(request))!},signal,JSON.stringify({url:args.url,destination,format:args.format,maxBytes:args.maxBytes,sha256:args.sha256}),{isolationAvailable:support.available});
      return this.withWorkspaceWrite(chat,async()=>{
        signal.throwIfAborted(); const current=this.context(chat);
        if(current.mode!==policy.mode||current.revision!==policy.revision)throw new ToolFailure('PERMISSION_CHANGED','Project permissions changed before asset download.');
        if(await canonicalProjectPath(workspace.root,args.destination)!==destination)throw new ToolFailure('ASSET_PATH_CHANGED','Asset destination changed after review.');
        let result;
        try { result=await this.options.execution!.execute(request,signal); signal.throwIfAborted(); }
        catch (error) { this.mutated(chat); throw error; } // Cancellation may race the final atomic replacement.
        finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
        let report:any;try{report=JSON.parse(result.output.trim())}catch{report={error:result.output.slice(-2000)||'Asset download did not return a validation report.',code:'ASSET_DOWNLOAD'}}
        if(result.exitCode!==0||!report.validated) return {...result,...report,isError:true};
        this.mutated(chat);return {...result,...report,path:args.destination,hash:report.sha256,projectChanged:true};
      });
    }
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
      return integrated;
    }
    if (name === 'search_project_files') {
      await this.authorize(chat, { kind: 'read', paths: [workspace.root] }, signal);
      return { matches: await new Workspace(workspace.root).search(args.query) };
    }
    const target = await resolve();
    const editing = name === 'edit_project_file' || name === 'patch_project_file';
    if (editing) {
      this.checkWorkerWrite(chat, target);
      if (args.revision) {
        const revision = this.revisions.get(args.revision);
        if (!revision || revision.chatId !== chat.id || revision.target !== target) throw new Error('Unknown read revision for this file/chat. Read the file again.');
        args.expectedHash = revision.hash;
      }
      if (args.expectedHash === undefined || (name === 'patch_project_file' && args.expectedHash === null)) throw new Error('Supply the revision token or exact expectedHash from read_project_file. Use expectedHash:null only to create a new file.');
    }
    if (name === 'run_project_command' || name === 'run_project_process' || name === 'start_project_server') {
      if (worker?.readOnly) throw new Error('This worker cannot run commands.');
      const read = await Promise.all((args.readPaths ?? []).map((value: string) => canonicalProjectPath(workspace.root, value)));
      const write = await Promise.all((args.writePaths ?? []).map((value: string) => canonicalProjectPath(workspace.root, value)));
      write.forEach(value => this.checkWorkerWrite(chat, value));
      const request: ProjectExecutionRequest = { command: args.command, cwd: target, mode: policy.mode, workspaceRoot: workspace.root, readableRoots: read,
        writableRoots: worker ? await Promise.all(worker.ownedPaths.map(value => canonicalProjectPath(workspace.root, value))) : [workspace.root, ...write], network: args.network ?? 'deny', win32k: args.win32k ?? true, confined: Boolean(worker), loopback: name === 'start_project_server' };
      if (name === 'run_project_process') Object.assign(request, { executable: args.executable, args: args.args, stdin: args.stdin });
      const support = this.options.execution ? await this.options.execution.probe(request, signal) : { available: false };
      if ('version' in support) chat.executionSupport = support;
      const commandState = () => commandSnapshot(workspace.root);
      const before = await commandState();
      const commandAction: ProjectAction = { kind: 'command', command: args.command, cwd: target, paths: policy.mode === 1 ? [...read, ...write] : write, contentHash: hash(JSON.stringify([before.digest, request]))! };
      await this.authorize(chat, commandAction, signal, JSON.stringify({ ...request, scriptState: before, reason: 'Review command effects and requested filesystem/network scope.' }, null, 2), { isolationAvailable: support.available });
      if ((policy.mode !== 3 || worker) && !support.available) throw new Error('Native confinement is unavailable for this command.');
      return this.withWorkspaceWrite(chat, async () => {
        const current = this.context(chat);
        if (current.mode !== policy.mode || current.revision !== policy.revision) throw new ToolFailure('PERMISSION_CHANGED', 'Project permissions changed after review.');
        if (await resolve() !== target) throw new ToolFailure('WORKING_DIRECTORY_CHANGED', 'Working directory changed after review.');
        const reviewed = compareCommandSnapshots(before, await commandState());
        if (reviewed.state === 'changed') throw new ToolFailure('SOURCE_CHANGED', 'Source files changed after review.', { changedPaths: reviewed.changedPaths });
        signal.throwIfAborted();
        if (name === 'start_project_server') {
          if (!this.options.servers) throw new Error('Project servers are unavailable.');
          return this.options.servers.start(chat.id, request, args.port, signal);
        }
        if (name === 'run_project_process' && !this.options.execution) throw new Error('Structured process execution requires the project execution adapter.');
        let result;
        try { result = this.options.execution ? await this.options.execution.execute(request, signal) : await runCommand(args.command, target, signal, workspace.root); }
        catch (error) { this.mutated(chat); throw error; } // Interrupted commands can leave partial writes.
        signal.throwIfAborted(); this.commandResults.get(chat.id)?.push({ command: args.command, ...result });
        const after = await commandState();
        const comparison = compareCommandSnapshots(before, after);
        const projectChanged = comparison.state === 'changed';
        if (comparison.state !== 'unchanged') this.mutated(chat);
        return { ...result, projectChanged, projectChange: comparison.state, verificationUnknown: comparison.state === 'unknown', changedPaths: comparison.changedPaths };
      });
    }
    const action: ProjectAction = { kind: editing ? 'write' : 'read', paths: [target], ...(editing ? { contentHash: hash(JSON.stringify(args))! } : {}) };
    await this.authorize(chat, action, signal, editing ? JSON.stringify({ operation: name === 'patch_project_file' ? 'Patch unique text' : 'Replace entire text file', path: target, proposedContent: args.content, ...args }, null, 2) : undefined);
    if (await resolve() !== target) throw new Error('The target changed while permission was requested. Try again.');
    const root = within(workspace.root, target) ? workspace.root : path.parse(target).root;
    const relative = path.relative(root, target) || '.';
    if (name === 'list_project_files') return { files: await new Workspace(target).list(), limit: 200 };
    if (name === 'read_project_file') {
      const result = await new Workspace(root).read(relative, args.start, args.end);
      const revision = randomUUID(); this.revisions.set(revision, { chatId: chat.id, target, hash: result.hash });
      if (this.revisions.size > 1000) this.revisions.delete(this.revisions.keys().next().value!);
      return { ...result, revision };
    }
    return this.withWorkspaceWrite(chat, async () => {
      signal.throwIfAborted();
      // Authorization and link targets must remain valid after waiting for the writer.
      if (await resolve() !== target) throw new Error('The file target changed before the edit.');
      const current = this.context(chat);
      if (current.mode !== policy.mode || current.revision !== policy.revision) throw new Error('Project permissions changed before this edit.');
      signal.throwIfAborted();
      const files = new Workspace(root);
      const change = name === 'patch_project_file' ? await files.patch(relative, args.expectedHash, args.oldText, args.newText) : await files.edit(relative, args.expectedHash, args.content, args.replacementIntent);
      this.mutated(chat);
      const nextHash = hash(change.after)!;
      const revision = randomUUID(); this.revisions.set(revision, { chatId: chat.id, target, hash: nextHash });
      if (this.revisions.size > 1000) this.revisions.delete(this.revisions.keys().next().value!);
      return { path: change.path, previousHash: hash(change.before), hash: nextHash, revision, at: change.at, isolated: false };
    });
  }
}
