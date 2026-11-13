import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatThread } from '../shared/types';
import { Store } from './store';
import { Workspace, hash } from './workspace';
import { ProjectReadCache } from './project-read-cache';
import { validateResumedDiagnosis } from './project-task-lifecycle';
import { ChatApprovals } from './chat-approvals';
import { assessProjectAction, OneShotProjectGrants, projectProtectedPaths, projectWritableRoots, type ProjectAction, type ProjectPolicyContext, type ProjectPolicyOptions } from './project-policy';
import { ProjectWorktreeService, type ProjectWorkspace } from './project-worktrees';
import { runCommand } from './commands';
import { projectContext, ProjectNotes } from './project-context';
import { discoverProjectSkills, readProjectSkill, loadProjectWorkflows } from './project-skills';
import { ProjectExecutionAdapter, possibleSandboxConflict, type ProjectExecutionRequest, type ProjectExecutionResult } from './project-execution';
import { assertPlanningToolAllowed } from './chat-planning';
import { ProjectMaps } from './project-maps';
import { DEPENDENCY_GRAPHS_ENABLED } from './project-features';
import type { ProjectPluginPolicy } from './project-plugin-policy';
import type { ProjectServers } from './project-servers';
import { commandSnapshot, compareCommandSnapshots } from './project-command-state';
import { ToolFailure, toolFailed } from './tool-outcome';
import { projectCommandApprovalReason } from './project-command-risk';
import { normalizeProjectToolInput } from './project-tool-input';
import { projectAssetScript } from './project-assets';
import { pythonEnvironmentSchema, planPythonEnvironment, revalidatePythonEnvironment, setupPythonEnvironment, pythonInstallNeedsNetwork } from './project-python-environment';
import { discoverProjectPython, findPythonLauncher, pythonSearchRoots } from './project-python-discovery';
import { inspectProjectTarget, reconcileProjectTarget } from './project-target';
import { endpointDiagnosticSchema, endpointDiagnosticRequest, probeProjectEndpoint } from './project-endpoint-diagnostic';
import { requireDiagnosisForEdit, backendScopeReason, enforceCommandTaskScope } from './project-task-policy';
import { patchProjectRecord } from './project-records';
import { ProjectBatches, projectBatchSchemas, projectBatchDescriptions } from './project-batches';
import { chatEvidence } from './source-memory';

const filename = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const recordPrimitive = z.union([z.string().max(20000), z.number().finite(), z.boolean(), z.null()]);
const sandboxPermissionFields = {
  filesystemAccess: z.enum(['read-only', 'workspace-write']).describe('Optional command filesystem scope. Read-only mode defaults to scratch-only writes. Request workspace-write for a one-time reviewed write command. Task diagnostic and worker limits still apply.').optional(),
  sandboxPermissions: z.enum(['use_default', 'require_escalated']).describe('Request one-time user approval to run outside isolation when a local model, library or resource cannot be accessed in the sandbox. This never grants permission by itself.').optional(),
  justification: z.string().trim().min(1).max(2000).describe('Explain why this exact command needs access outside the sandbox.').optional(),
};
const schemas = {
  ...projectBatchSchemas,
  list_project_skills: z.object({}).strict(),
  read_project_skill: z.object({ id: z.string().max(200), resource: z.string().min(1).max(1000).optional() }).strict(),
  inspect_project_target: z.object({ entryPoint: filename.optional() }).strict(),
  discover_project_python: z.object({ includeLauncher: z.boolean().default(false) }).strict(),
  probe_project_endpoint: endpointDiagnosticSchema,
  setup_project_python_environment: pythonEnvironmentSchema,
  download_project_asset: z.object({ url: z.string().url().max(4000), destination: filename, format: z.enum(['json','gguf','wasm','binary']), maxBytes: z.number().int().min(1).max(1073741824), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  start_project_server: z.object({ ...sandboxPermissionFields, command: z.string().trim().min(1).max(10000), port: z.number().int().min(1024).max(65535), cwd: filename.optional() }).strict(),
  project_server_status: z.object({ id: z.string().uuid().optional() }).strict(),
  stop_project_server: z.object({ id: z.string().uuid() }).strict(),
  list_project_files: z.object({ path: filename.optional() }).strict(),
  read_project_file: z.object({ path: filename, start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }).strict(),
  read_project_record: z.object({ path: filename, variable: z.string().min(1).max(200), key: z.string().min(1).max(500) }).strict(),
  list_project_records: z.object({ path: filename, variable: z.string().min(1).max(200), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  patch_project_record: z.object({ path: filename, variable: z.string().min(1).max(200), key: z.string().min(1).max(500), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), revision: z.string().uuid().optional(), fields: z.record(z.string().min(1).max(200).refine(name => name !== '__proto__'), z.union([recordPrimitive, z.array(recordPrimitive).max(200)])).refine(fields => Object.keys(fields).length > 0 && Object.keys(fields).length <= 30 && JSON.stringify(fields).length <= 30000, 'Supply 1–30 fields totaling at most 30,000 characters.') }).strict(),
  search_project_files: z.object({ query: z.string().min(1).max(200) }).strict(),
  edit_project_file: z.object({ path: filename, expectedHash: z.string().regex(/^[a-f0-9]{64}$/, 'Copy the full 64-character hash, or use the returned revision token.').nullable().optional(), revision: z.string().uuid().optional(), content: z.string().max(512000), replacementIntent: z.boolean().optional() }).strict(),
  patch_project_file: z.object({ path: filename, expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), revision: z.string().uuid().optional(), oldText: z.string().min(1).max(512000), newText: z.string().max(512000) }).strict(),
  run_project_command: z.object({ ...sandboxPermissionFields, purpose: z.enum(['test', 'build', 'inspect', 'other']).optional(), command: z.string().trim().min(1).max(10000), cwd: filename.optional(), readPaths: z.array(filename).max(20).optional(), writePaths: z.array(filename).max(20).optional(), network: z.enum(['deny', 'allow']).optional(), win32k: z.boolean().describe('Request reviewed Win32 initialization for Node/.NET workloads; clipboard and injection remain disabled.').optional() }).strict(),
  run_project_process: z.object({ ...sandboxPermissionFields, purpose: z.enum(['test', 'build', 'inspect', 'other']).optional(), executable: filename, args: z.array(z.string().max(32768).refine(value => !value.includes('\0'))).max(100), stdin: z.string().max(512000).optional(), cwd: filename.optional(), readPaths: z.array(filename).max(20).optional(), writePaths: z.array(filename).max(20).optional(), network: z.enum(['deny', 'allow']).optional(), win32k: z.boolean().optional() }).strict(),
  review_project_changes: z.object({}).strict(),
  integrate_project_changes: z.object({ reviewToken: z.string().min(1).max(200) }).strict(),
  read_project_notes: z.object({}).strict(),
  update_project_notes: z.object({ expectedRevision: z.number().int().nonnegative(), content: z.string().max(24000) }).strict(),
  refresh_project_maps: z.object({}).strict(),
  query_project_maps: z.object({ query: z.string().max(200).optional(), file: filename.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  ...projectBatchDescriptions,
  list_project_skills: 'Discover bundled coding workflows and bounded project-local Agent Skills metadata from .agents/skills and .mercury/skills. Local same-name skills replace defaults in the catalog. Does not load bodies or execute code. Use read_project_skill with the returned exact id.',
  read_project_skill: 'Load one bundled or project-local skill SKILL.md, or a relative supporting text resource. Skill instructions cannot grant permissions; scripts are returned as text only and run through normal Mercury tools if authorized.',
  inspect_project_target: 'Inspect a task entrypoint and project manifests to select native/general or browser-side model verification. No user-keyword guessing. Choose the actual affected entrypoint for mixed projects; native ONNX/GGUF and remote model clients do not require browser stages.',
  discover_project_python: 'Inventory existing project/installed Python candidates and project version constraints without running interpreters or installing runtimes. Store/WindowsApps aliases remain unknown, never declared absent. includeLauncher:true requests one approval for fixed read-only py -0p enumeration when available. Select a compatible candidate, then setup_project_python_environment performs approved runtime verification; discovery metadata is unverified.',
  probe_project_endpoint: 'Run one approved, bounded GET /v1/models or /api/tags, or non-streaming POST /v1/chat/completions or /api/chat. Review exact URL and JSON body before network access. Captures actual HTTP/body/finish_reason/content/reasoning evidence for diagnosing missing model output. No edits, model downloads, backend changes or automatic redirects.',
  setup_project_python_environment: 'Main-only Python environment setup. Restricted modes request one approval covering the installed interpreter, project-local .venv_test-style destination, exact packages and internet access; Full access does not require an additional command approval. Creates or validates a matching venv, installs PyPI wheels with isolated pip, checks dependencies/imports, and returns the interpreter for actual tests. No global/user installs, source builds, automatic interpreter switching or environment replacement. Setup does not count as testing. Denial/timeout ends setup with a clear blocker.',
  download_project_asset: 'Download a project asset with a declared format and byte limit using authorized confined execution. Rejects HTTP errors, error pages, invalid JSON/GGUF/WASM, size/hash mismatches. Atomically replaces the destination only after validation. Prefer this over curl for model metadata/weights.',
  start_project_server: 'Start a managed website dev server for up to one hour. Run in the foreground, bind to 127.0.0.1 with the requested port (for Vite use --host 127.0.0.1 --port PORT --strictPort). Returns a URL usable with browser_open. Installs/builds use run_project_command first.',
  project_server_status: 'Read running status, expiry and bounded output from a server in this chat. Omit id to discover all owned servers; check before starting another.',
  stop_project_server: 'Stop a server and its child processes started in this chat.',
  list_project_files: 'List bounded project files. Optional relative path; use read_project_file to inspect files.',
  read_project_file: 'Read up to 200 lines of a filesystem file, returning its content hash for safe edits. Paths are relative to this chat worktree, or absolute. Outside-workspace access follows project permissions.',
  read_project_record: 'Read one static object record by top-level variable and record key in a JS/TS catalog up to 8 MiB. Returns literal fields and a revision; never executes project code. Prefer this for individual game metadata instead of rereading a large catalog.',
  list_project_records: 'List exact string record keys in a static JS/TS catalog without executing code or reading every source line. Supply its path and top-level variable, then follow nextOffset until null. Returns up to 50 keys, totalRecords, hash and revision. Use these keys with read_project_record and patch_project_record; indices are not keys.',
  patch_project_record: 'Update literal fields of one JS/TS catalog record by variable and key. Pass the revision from read_project_record. Adds missing fields and preserves surrounding content. Rejects dynamic or ambiguous records. Main is the integrating writer; research workers return proposals.',
  search_project_files: 'Search project text files for a literal substring, with bounded results.',
  edit_project_file: 'Replace an ENTIRE text file, not a snippet. Prefer patch_project_file for small changes. Pass revision from read_project_file unchanged, or expectedHash. Set replacementIntent:true when deliberately removing more than half of an existing file. For a missing file omit revision/expectedHash, or pass expectedHash:null (JSON null). This is create-only and rejects an existing path. Edits apply directly to the selected folder. Do not overwrite unrelated work.',
  patch_project_file: 'Change exactly one occurrence of oldText to newText. Include sufficient context for a unique match. Pass the revision token from read_project_file unchanged (or expectedHash). Preferred for partial edits; unrelated content is preserved.',
  run_project_process: 'Run an executable with argument strings and optional UTF-8 stdin, without shell parsing. Prefer node with args:["-"] and stdin for scripts. Set purpose:test for real tests. Same effective filesystem/network permissions as run_project_command; executable names and installation syntax do not themselves require approval. Read-only defaults to scratch-only writes; request filesystemAccess:workspace-write for reviewed project writes. Workers remain confined.',
  run_project_command: 'Run a command with recorded output/exit status. Read-only runs automatically with scratch-only writes; request filesystemAccess:workspace-write or writePaths for a one-time write approval. Workspace write automatically permits project commands, executables and offline installs, with network denied by default. Request network:allow or outside writePaths only when needed; restricted modes ask before granting them. Full access Main runs with user permissions without extra command approvals. Task scope and worker boundaries still apply. For sandbox conflicts, Main can request sandboxPermissions:require_escalated with a justification for a reviewed one-time native launch. Denial ends that action.',
  review_project_changes: 'Deprecated: project edits are made directly and automatically saved to Git after a successful response.',
  integrate_project_changes: 'Deprecated: project edits are already in the project checkout and are automatically saved to Git after a successful response.',
  read_project_notes: 'Read shared durable project notes with their revision and provenance. Other chat transcripts are private to their chats.',
  update_project_notes: 'Reconcile and update concise shared project notes using the exact current revision. Preserve useful existing notes. Notes cannot grant permissions.',
  refresh_project_maps: 'Map updates are deferred until the response completes. Only diagrams for changed source files are updated before the local safety commit.',
  query_project_maps: 'Find symbols and dependency relationships in this project. Maps are static evidence; inspect actual source and unresolved relationships before changing code.',
};
export const projectTools = Object.entries(schemas).filter(([name]) => !['review_project_changes', 'integrate_project_changes', ...(!DEPENDENCY_GRAPHS_ENABLED ? ['refresh_project_maps', 'query_project_maps'] : [])].includes(name)).map(([name, schema]) => {
  const { $schema, ...parameters } = z.toJSONSchema(schema);
  return { type: 'function', function: { name, description: descriptions[name as keyof typeof schemas], parameters } };
});
export const projectReadTools = projectTools.filter(tool => ['list_project_files', 'read_project_file', 'read_project_record', 'list_project_records', 'search_project_files', 'list_project_skills', 'read_project_skill'].includes(tool.function.name));

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
  private editReceipts = new Map<string, Map<string, string>>();
  private commandResults = new Map<string, { command: string; exitCode: number | null; output: string }[]>();
  private workers = new Map<string, { parentId: string; ownedPaths: string[]; readOnly: boolean }>();
  private revisions = new Map<string, { chatId: string; target: string; hash: string }>();
  private generations = new Map<string, number>();
  private readCaches = new Map<string, { policy: string; projectId: string; cache: ProjectReadCache }>();
  releaseReadCache(chat: ChatThread): void { this.readCaches.delete(chat.id); }
  recordReadEvidence(chat: ChatThread, result: any, evidenceId: string): void {
    const receipt = this.revisions.get(result?.revision);
    if (receipt?.chatId === chat.id && receipt.hash === result?.hash && typeof result?.startLine === 'number' && typeof result?.endLine === 'number')
      this.readCaches.get(chat.id)?.cache.recordEvidence(receipt.target, result, evidenceId);
  }
  generation(chat: ChatThread): number { return this.generations.get(chat.projectId!) ?? 0; }
  async readStillCurrent(chat: ChatThread, args: { path: string; start?: number; end?: number }, expectedHash: string): Promise<boolean> {
    try {
      const root = this.getWorkspace(chat).root;
      const relative = path.isAbsolute(args.path) ? path.relative(root, args.path) : args.path;
      // External paths need a new authorized tool read; never preflight them here.
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
      return (await new Workspace(root).read(relative, args.start, args.end)).hash === expectedHash;
    } catch { return false; }
  }
  private mutated(chat: ChatThread) { this.generations.set(chat.projectId!, this.generation(chat) + 1); }
  constructor(private store: Store, private approvals: ChatApprovals, private worktrees: ProjectWorktreeService, private notes = new ProjectNotes(path.join(worktrees.storageRoot, 'notes')), private options: { execution?: ProjectExecutionAdapter; maps?: ProjectMaps; servers?: ProjectServers } = {}) {}

  async initializeProject(root: string): Promise<void> {
    await this.worktrees.initialize(root);
    // Dependency analysis can be expensive; prepare it when a conversation starts.
  }

  async prepare(chat: ChatThread, signal: AbortSignal): Promise<string> {
    this.releaseReadCache(chat);
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
          const relative = path.isAbsolute(read.path) ? path.relative(workspace.root, read.path) : read.path;
          if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) { retained.push(read); continue; }
          const current = await new Workspace(workspace.root).read(relative, read.startLine, read.endLine);
          if (current.hash === read.hash) retained.push({ ...read, path: relative.replaceAll('\\', '/') });
        } catch { /* Missing or changed sources invalidate their old observations. */ }
      }
      if (retained.length !== chat.projectHandoff.reads.length) {
        chat.projectHandoff.browser = undefined;
        chat.projectHandoff.generation = (chat.projectHandoff.generation ?? 0) + 1;
        chat.projectHandoff.lastMutationAt = Date.now();
        for (const requirement of chat.projectHandoff.requirements) if (requirement.status === 'passed' || requirement.status === 'completed') { requirement.status = 'not_run'; delete requirement.completionNote; }
      }
      chat.projectHandoff.reads = retained;
      const snapshots = [];
      for (const snapshot of chat.projectHandoff.snapshots ?? []) {
        try {
          const relative = path.isAbsolute(snapshot.path) ? path.relative(workspace.root, snapshot.path) : snapshot.path;
          if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) { snapshots.push(snapshot); continue; }
          if (await new Workspace(workspace.root).snapshotHash(relative) !== snapshot.hash) throw new Error('Changed source');
          snapshots.push({ ...snapshot, path: relative.replaceAll('\\', '/') });
        } catch {
          chat.projectHandoff.generation = (chat.projectHandoff.generation ?? 0) + 1;
          chat.projectHandoff.lastMutationAt = Date.now(); chat.projectHandoff.browser = undefined;
          for (const requirement of chat.projectHandoff.requirements) if (requirement.status === 'passed' || requirement.status === 'completed') { requirement.status = 'not_run'; delete requirement.completionNote; }
        }
      }
      chat.projectHandoff.snapshots = snapshots;
      const previous = chat.projectHandoff.verificationTarget;
      const detected = await reconcileProjectTarget(workspace.root, previous?.entryPoint);
      chat.projectHandoff.verificationTarget = detected;
      chat.projectHandoff.requiresModelVerification = detected.kind === 'browser_model' || (detected.kind === 'unknown' && chat.projectHandoff.requiresModelVerification === true);
      if (!previous && detected.kind === 'general' && detected.sources.some(source => /(?:requirements\.txt|pyproject\.toml|main\.py)$/.test(source.path)) && !/\bbrowser|website|web app\b/i.test(chat.projectHandoff.objective ?? '')) {
        const legacy = chat.projectHandoff.requirements.filter(item => item.stage && item.verification === 'browser');
        chat.projectHandoff.retiredRequirements = [...(chat.projectHandoff.retiredRequirements ?? []), ...legacy.map(requirement => ({ requirement, reason: 'Legacy phrase-based browser criteria do not apply to the inspected native Python task.' }))].slice(-40);
        chat.projectHandoff.requirements = chat.projectHandoff.requirements.filter(item => !legacy.includes(item));
      }
    }
    if (DEPENDENCY_GRAPHS_ENABLED && this.options.maps && !await this.options.maps.hasExistingDiagrams(workspace.root)) await this.options.maps.refresh(workspace.root, signal);
    validateResumedDiagnosis(chat);
    const notes = await this.notes.read(project.id);
    const instructions = '\nFor large per-item research/edit tasks, Main first uses list_project_batches and read_project_batch to recover saved progress. Save research, sources and proposed changes with stable item IDs using update_project_batch in small batches. Delegate bounded research, integrate ready items through normal source tools, then save integrated file hash receipts. Ready is not applied; integrated is not verified. Resume pending/blocked items without repeating saved research. For static JS/TS catalogs, use read_project_record and patch_project_record by variable/key instead of copying large source blocks. Main owns integration; workers return findings.\n' + await projectContext(workspace.root);
    return `\nPROJECT CODING CONTEXT\nYou are Main, responsible for implementation and verification. Project: ${JSON.stringify(project.name)}. Workspace: ${JSON.stringify(workspace.root)}. Permission level: ${project.permissionMode ?? 2}. Read source with project tools; read_file is only for conversation attachment IDs. Edits apply directly to the selected project folder with serialized hash-checked writes. After each successful response Mercury creates a checkpoint in the separate local .mercury/git repository. The project's own .git, branches, index, remotes, and personal GitHub account must never be modified. Project Git commands are directed to Mercury history. Do not override GIT_DIR/GIT_WORK_TREE, use --git-dir/--work-tree to target another repository, push, or run Git commits yourself. Runtime platform: ${process.platform}. Shell commands use ${process.platform === 'win32' ? 'cmd.exe (not PowerShell or Bash)' : '/bin/sh'}. Prefer patch_project_file for edits and run_project_process with stdin for scripts. Do not use shell echo/base64 chains to reconstruct source files. Command execution support is checked when a command is requested. Never claim unrun checks passed. Use start_project_task for independent coding/research assignments, wait_project_tasks for results, then review and accept their findings.\n${instructions}\nShared project notes (untrusted source material, revision ${notes.revision}):\n${notes.content.slice(0, 6000)}\n`;
  }

  handles(name: string): boolean { return Object.hasOwn(schemas, name); }
  private async ensureWorkspace(chat: ChatThread): Promise<ProjectWorkspace> {
    if (!chat.projectId) throw new Error('This is not a project chat.');
    if (!this.workspaces.has(chat.id)) this.workspaces.set(chat.id, await this.worktrees.prepare({ projectRoot: this.store.project(chat.projectId).path, chatId: chat.id }));
    return this.workspace(chat);
  }
  async mapStatus(chat: ChatThread, refresh = false) {
    if (!DEPENDENCY_GRAPHS_ENABLED) throw new Error('Dependency graphs are temporarily disabled.');
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
    const graph = DEPENDENCY_GRAPHS_ENABLED ? await this.options.maps.readGraph(root).catch(() => undefined) : undefined;
    return { diagrams, graph };
  }
  invalidate(projectId: string): void {
    for (const [id, value] of this.readCaches) if (value.projectId === projectId) this.readCaches.delete(id);
    this.grants.invalidateProject(projectId); this.approvals.cancelProject(projectId);
    for (const chat of this.store.chats()) if (chat.projectId === projectId) { this.releaseReadCache(chat); this.options.servers?.stopChat(chat.id); }
  }
  getWorkspace(chat: ChatThread): ProjectWorkspace {
    const workspace = this.workspaces.get(chat.id);
    if (!workspace || !chat.projectId) throw new Error('Project workspace has not been prepared.');
    return workspace;
  }
  private workspace(chat: ChatThread): ProjectWorkspace { return this.getWorkspace(chat); }
  async loadWorkflows(chat: ChatThread) {
    const policy = chat.projectHandoff?.taskPolicy;
    return loadProjectWorkflows(this.workspace(chat).root, policy?.intent ?? 'implementation', policy?.request);
  }
  async prepareWorker(child: ChatThread, parent: ChatThread, workspace: ProjectWorkspace, scope: { ownedPaths: string[]; readOnly: boolean }): Promise<string> {
    this.releaseReadCache(child);
    if (!parent.projectId || child.projectId !== parent.projectId) throw new Error('Invalid worker project ownership.');
    if (parent.collaborationMode === 'plan' && !scope.readOnly) throw new ToolFailure('PLAN_MODE_READ_ONLY', 'Plan mode only permits read-only investigations.');
    child.collaborationMode = parent.collaborationMode;
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
  releaseWorker(child: ChatThread): void { this.releaseReadCache(child); this.workers.delete(child.id); this.workspaces.delete(child.id); }
  withWorkspaceWrite<T>(chat: ChatThread, operation: () => Promise<T>): Promise<T> {
    this.getWorkspace(chat);
    return this.serial(chat.projectId!, operation);
  }
  async commitResponse(chat: ChatThread, signal: AbortSignal) {
    return this.withWorkspaceWrite(chat, async () => {
      const workspace = this.getWorkspace(chat);
      const changed = await this.worktrees.changedPaths(workspace, signal);
      if (!changed.length) return { committed: false };
      if (DEPENDENCY_GRAPHS_ENABLED) await this.options.maps?.updateChanged(workspace.root, changed, signal);
      return this.worktrees.commitResponse(workspace, signal);
    });
  }
  async refreshAfterIntegration(chat: ChatThread, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); // Diagram updates are deferred to the completed response.
  }
  toolsForWorker(readOnly: boolean) {
    return projectTools.filter(tool => ['list_project_skills', 'read_project_skill', 'list_project_files', 'read_project_file', 'read_project_record', 'list_project_records', 'search_project_files', 'read_project_notes', 'query_project_maps', ...(!readOnly ? ['edit_project_file', 'patch_project_file', 'run_project_command', 'run_project_process', 'download_project_asset'] : [])].includes(tool.function.name));
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
    if (action.kind === 'write') options = { ...options, protectedReadOnlyRoots: await Promise.all(projectProtectedPaths(context.workspaceRoot).map(value => canonicalProjectPath(context.workspaceRoot, value))) };
    const decision = assessProjectAction(this.workers.has(chat.id) && context.mode === 3 ? { ...context, mode: 2 } : context, action, options);
    if (decision.status === 'deny') throw new Error(decision.reason);
    if (decision.status === 'approval') {
      await this.approvals.request(context.chatId, `Project ${action.kind}: ${this.store.project(chat.projectId!).name}`, details ?? JSON.stringify({ reason: decision.reason, ...action }, null, 2), signal,
        { projectId: context.projectId, policyRevision: context.revision, kind: action.kind, paths: action.paths, agentId: action.agentId ?? 'main', mandatoryUserApproval: Boolean(this.workers.has(chat.id) || action.approvalReason || options.reviewedNativeAvailable),
          requester: { agent: this.workers.has(chat.id) ? `Worker ${chat.id}` : 'Main', model: chat.profile.model, provider: chat.profile.provider, tool: action.tool } });
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
    return { mode: context.mode, collaborationMode: chat.collaborationMode, workspaceRoot: context.workspaceRoot, execution: this.options.execution,
      authorize: async (details, request, signal) => {
        assertPlanningToolAllowed(chat, 'plugin_call_tool', {});
        const policy = chat.projectHandoff?.taskPolicy;
        if (policy && ['answer', 'setup'].includes(policy.intent)) throw new ToolFailure('TASK_SCOPE_PLUGIN_BLOCKED', 'This request permits inspection or bounded setup only. Unbounded plugin execution needs a separate user request. Use project reads and the reviewed setup/diagnostic tools.');
        if (policy?.intent === 'debug') requireDiagnosisForEdit(chat.projectHandoff);
        const support = request && this.options.execution ? await this.options.execution.probe(request, signal) : { available: request === null };
        await this.authorize(chat, { kind: 'plugin', paths: request?.writableRoots, command: request?.command, approvalReason: policy?.intent === 'debug' ? 'Review this plugin operation as a separate debugging scope decision; plugin effects are not inferred from the diagnosis.' : undefined, contentHash: hash(JSON.stringify([details, request]))! }, signal, details, { isolationAvailable: support.available });
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

  private async integrationReceipt(chat: ChatThread, receipt: { path: string; hash: string }): Promise<boolean> {
    const root = this.workspace(chat).root;
    const target = await canonicalProjectPath(root, await new Workspace(root).resolve(receipt.path));
    if (this.editReceipts.get(chat.id)?.get(target) === receipt.hash) return true;
    // Host-saved successful tool evidence survives restart; a source read or an
    // assistant's claim is never evidence that an edit actually happened.
    for (const evidence of chatEvidence(chat)) {
      if (!['edit_project_file', 'patch_project_file', 'patch_project_record'].includes(evidence.tool)) continue;
      try {
        const result = JSON.parse(evidence.result);
        if (!toolFailed(result) && result.hash === receipt.hash && result.previousHash !== result.hash && typeof result.path === 'string' && await canonicalProjectPath(root, result.path) === target) return true;
      } catch { /* Malformed or historical excerpts cannot certify an edit. */ }
    }
    return false;
  }

  async execute(chat: ChatThread, name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!this.handles(name)) throw new Error('Unknown project tool.');
    assertPlanningToolAllowed(chat, name, raw);
    const args: any = schemas[name as keyof typeof schemas].parse(normalizeProjectToolInput(name, raw));
    if (name === 'run_project_process') args.command = JSON.stringify([args.executable, ...args.args]);
    const workspace = this.workspace(chat);
    const worker = this.workers.get(chat.id);
    if (worker && !this.toolsForWorker(worker.readOnly).some(tool => tool.function.name === name)) throw new Error('This tool is outside the worker assignment.');
    if (await fs.realpath(workspace.root) !== workspace.root) throw new Error('Project workspace folder identity changed. Reopen the project before continuing.');
    if (name === 'list_project_skills') return discoverProjectSkills(workspace.root);
    if (name === 'read_project_skill') return readProjectSkill(workspace.root, args.id, args.resource);
    if (name === 'project_server_status' || name === 'stop_project_server') {
      if (!this.options.servers) throw new Error('Project servers are unavailable.');
      return name === 'project_server_status' ? this.options.servers.status(chat.id, args.id) : this.options.servers.stop(chat.id, args.id);
    }
    if (name === 'read_project_notes') return this.notes.read(chat.projectId!);
    if (name === 'update_project_notes') return this.notes.update(chat.projectId!, chat.id, args.expectedRevision, args.content);
    if (name === 'list_project_batches' || name === 'read_project_batch' || name === 'update_project_batch') {
      if (worker) throw new Error('Batch checkpoints are Main-only. Return findings and proposals to Main.');
      const batchPolicy = this.context(chat);
      await this.authorize(chat, { kind: name === 'update_project_batch' ? 'write' : 'read', paths: [path.join(workspace.root, '.mercury', 'batches')], ...(name === 'update_project_batch' ? { contentHash: hash(JSON.stringify(args))! } : {}) }, signal, name === 'update_project_batch' ? JSON.stringify(args) : undefined);
      const batches = new ProjectBatches(workspace.root, receipt => this.integrationReceipt(chat, receipt));
      if (name === 'list_project_batches') return batches.list();
      if (name === 'read_project_batch') return batches.read(args);
      return this.serial(chat.projectId!, async () => {
        signal.throwIfAborted();
        const currentPolicy = this.context(chat);
        if (currentPolicy.mode !== batchPolicy.mode || currentPolicy.revision !== batchPolicy.revision) throw new Error('Project permissions changed before saving the batch.');
        if (await fs.realpath(workspace.root) !== workspace.root) throw new Error('Project workspace folder identity changed before saving the batch.');
        return batches.update(chat.id, args);
      });
    }
    if (name === 'refresh_project_maps' || name === 'query_project_maps') {
      if (!DEPENDENCY_GRAPHS_ENABLED) throw new Error('Dependency graphs are temporarily disabled.');
      if (!this.options.maps) throw new Error('Dependency maps are unavailable.');
      if (name === 'query_project_maps') return this.options.maps.query(workspace.root, args);
      return { deferred: true, message: 'Changed source diagrams are updated automatically after the response completes, before its local safety commit.' };
    }
    const policy = this.context(chat);
    const ownerHandoff = worker ? this.store.chat(worker.parentId).projectHandoff : chat.projectHandoff;
    if (name === 'inspect_project_target') {
      const result = await inspectProjectTarget(workspace.root, args.entryPoint);
      if (ownerHandoff) { ownerHandoff.verificationTarget = result; ownerHandoff.requiresModelVerification = result.kind === 'browser_model'; }
      return result;
    }
    if (name === 'discover_project_python') {
      await this.authorize(chat, { kind: 'read', paths: [workspace.root, ...pythonSearchRoots()] }, signal);
      let output: string | undefined;
      let launcherStatus = args.includeLauncher ? 'unavailable' : 'not requested';
      if (args.includeLauncher) {
        const launcher = await findPythonLauncher();
        if (launcher) {
          const request: ProjectExecutionRequest = { command: 'List installed Python registrations', executable: launcher.path, args: ['-0p'], mode: policy.mode,
            workspaceRoot: workspace.root, cwd: workspace.root, network: 'deny', approvedNative: true, timeoutMs: 15000 };
          await this.authorize(chat, { kind: 'command', command: request.command, cwd: workspace.root,
            approvalReason: 'Run the fixed read-only Python launcher listing (-0p) with your user permissions. This lists registrations; it does not install or select a runtime.', contentHash: hash(JSON.stringify([request, launcher.hash]))! }, signal, JSON.stringify({ executable: launcher.path, args: ['-0p'], purpose: 'Read-only interpreter inventory', scope: 'User account execution; no filesystem/network confinement. Fixed listing only; no runtime installation.' }), { reviewedNativeAvailable: true });
          const current = await findPythonLauncher();
          if (!current || current.path !== launcher.path || current.hash !== launcher.hash) throw new ToolFailure('PYTHON_LAUNCHER_CHANGED', 'The reviewed launcher changed before enumeration.');
          if (!this.options.execution) throw new ToolFailure('PYTHON_DISCOVERY_EXECUTION', 'No execution adapter is available for the approved launcher listing.');
          const result = await this.options.execution.execute(request, signal);
          output = result.exitCode === 0 && !result.timedOut ? result.output : undefined;
          launcherStatus = output ? 'listed; versions remain unverified metadata' : 'listing failed; installed runtimes remain unknown';
        }
      }
      return { ...await discoverProjectPython(workspace.root, output), launcherStatus };
    }
    if (name === 'probe_project_endpoint') {
      const request = endpointDiagnosticRequest(args);
      await this.authorize(chat, { kind: 'command', command: `${request.method} ${request.url}`, cwd: workspace.root, network: 'allow',
        approvalReason: 'Review this exact model endpoint diagnostic request and payload. It uses the app network connection without executing project code.', contentHash: hash(JSON.stringify(request))! },
        signal, JSON.stringify({ operation: 'Probe selected model endpoint', ...request, timeoutSeconds: 30, responseLimitBytes: 64000, redirects: 'disabled', filesystemWrites: 'none' }), { isolationAvailable: true });
      return probeProjectEndpoint(request, signal);
    }
    if (name === 'setup_project_python_environment') {
      if (ownerHandoff?.taskPolicy?.intent === 'answer') throw new ToolFailure('TASK_SCOPE_EDIT_BLOCKED', 'An inspection-only request does not authorize environment changes.');
      if (!this.options.execution) throw new ToolFailure('ENVIRONMENT_EXECUTION_UNAVAILABLE', 'Python setup requires the project execution adapter.');
      const plan = await planPythonEnvironment(workspace.root, args, canonicalProjectPath);
      const request: ProjectExecutionRequest = { command: 'Set up project Python environment', executable: plan.interpreter, args: [],
        cwd: workspace.root, workspaceRoot: workspace.root, mode: policy.mode, writableRoots: [plan.destination],
        readableRoots: [path.dirname(plan.interpreter)], network: 'allow', win32k: true,
        environment: { PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null' } };
      const support = await this.options.execution.probe(request, signal);
      chat.executionSupport = support;
      const nativeFallback = !support.available;
      const details = JSON.stringify({ operation: 'Set up Python for this project', interpreter: plan.interpreter,
        expectedVersion: args.expectedVersion ?? 'Python 3 (detected and reported before installation)',
        projectRequirements: plan.requirements.constraints, existingEnvironmentVersion: plan.declaredEnvironmentVersion,
        environment: plan.destination, existingEnvironment: plan.existing, packages: args.packages, verifyImports: args.imports,
        network: 'allow for the package installation only; download PyPI wheels from https://pypi.org/simple',
        steps: ['Inspect the selected interpreter', plan.existing ? 'Validate the existing virtual environment' : 'Create the virtual environment', 'Install the listed packages into this environment', 'Check dependency compatibility and requested imports'],
        effectivePermissions: policy.mode === 3 || nativeFallback ? 'Runs with your user account filesystem and network access. Setup targets this virtual environment; OS isolation is not enforced.' : 'Isolated execution. Project environment writes; network access only during installation.',
        preservesExistingEnvironment: true, tests: 'Project tests run separately after setup.' }, null, 2);
      try {
        await this.authorize(chat, { kind: 'command', command: request.command, cwd: workspace.root, paths: [plan.destination],
          approvalReason: 'Review this Python environment setup, package installation and network access.', contentHash: hash(JSON.stringify([plan.fingerprint, args, request]))! },
          signal, details, { isolationAvailable: support.available, reviewedNativeAvailable: nativeFallback });
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        if (!/denied|approval timed out/i.test(message)) throw error;
        throw new ToolFailure(/timed out/i.test(message) ? 'ENVIRONMENT_APPROVAL_TIMED_OUT' : 'ENVIRONMENT_APPROVAL_DENIED',
          `Python environment setup did not run: ${message}`, { environmentPath: args.environmentPath, approvalRequired: true, stopProjectRun: true,
            nextAction: 'Wait for a new user message and explicit setup approval. Preserve the tests; do not try other Python paths, pip commands or download workarounds.' });
      }
      if (nativeFallback) request.approvedNative = true;
      return this.withWorkspaceWrite(chat, async () => {
        const current = this.context(chat);
        if (current.mode !== policy.mode || current.revision !== policy.revision) throw new ToolFailure('PERMISSION_CHANGED', 'Project permissions changed after setup review.');
        const reviewed = await planPythonEnvironment(workspace.root, args, canonicalProjectPath);
        if (reviewed.fingerprint !== plan.fingerprint) throw new ToolFailure('ENVIRONMENT_CHANGED', 'The interpreter or environment changed after review. Setup did not run.');
        return setupPythonEnvironment(plan, request, {
          signal, execute: step => this.options.execution!.execute(step, signal), mutated: () => this.mutated(chat),
          revalidate: async () => {
            const latest = this.context(chat);
            if (latest.mode !== policy.mode || latest.revision !== policy.revision) throw new ToolFailure('PERMISSION_CHANGED', 'Project permissions changed during setup.');
            await revalidatePythonEnvironment(plan, canonicalProjectPath);
          },
        });
      });
    }
    if (name === 'download_project_asset') {
      requireDiagnosisForEdit(ownerHandoff, args.destination.replace(/\\/g, '/'));
      if (ownerHandoff?.taskPolicy?.intent === 'setup') throw new ToolFailure('SETUP_TOOL_REQUIRED', 'Use the reviewed dependency setup tool; this setup request does not authorize model downloads.');
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
      await this.authorize(chat,{kind:'command',command:request.command,cwd:workspace.root,paths:[destination],network:request.network,contentHash:hash(JSON.stringify(request))!,
        approvalReason: ownerHandoff?.taskPolicy?.intent === 'debug' && !ownerHandoff.taskPolicy.backendChangeRequested ? 'Review this model/asset download separately from the requested debugging work.' : undefined },signal,JSON.stringify({url:args.url,destination,format:args.format,maxBytes:args.maxBytes,sha256:args.sha256}),{isolationAvailable:support.available});
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
      return { matches: await new Workspace(workspace.root).search(args.query, signal) };
    }
    const target = await resolve();
    const editing = name === 'edit_project_file' || name === 'patch_project_file' || name === 'patch_project_record';
    if (editing) {
      this.checkWorkerWrite(chat, target);
      requireDiagnosisForEdit(ownerHandoff, path.relative(workspace.root, target).replaceAll('\\', '/'));
      if (args.revision) {
        const revision = this.revisions.get(args.revision);
        if (!revision || revision.chatId !== chat.id || revision.target !== target) throw new Error('Unknown read revision for this file/chat. Read the file again.');
        args.expectedHash = revision.hash;
      }
      if (args.expectedHash === undefined || (name !== 'edit_project_file' && args.expectedHash === null)) throw new Error('Supply the revision token or exact expectedHash from the corresponding read tool. Use expectedHash:null only to create a new file.');
    }
    if (name === 'run_project_command' || name === 'run_project_process' || name === 'start_project_server') {
      if (worker?.readOnly) throw new Error('This worker cannot run commands.');
      const requestedNative = args.sandboxPermissions === 'require_escalated';
      if (requestedNative && worker) throw new ToolFailure('WORKER_SANDBOX_REQUIRED', 'Workers must remain confined to assigned paths. Ask Main to request this exact command with user approval.');
      enforceCommandTaskScope(ownerHandoff?.taskPolicy, args.executable ? [args.executable, ...(args.args ?? []), args.stdin ?? ''].join(' ') : args.command, args.purpose);
      if (policy.mode !== 3 && pythonInstallNeedsNetwork(args)) throw new ToolFailure('ENVIRONMENT_SETUP_REQUIRED',
        'This pip installation has no approved network access. Main should use setup_project_python_environment to review the interpreter, project environment, packages and network together.',
        { nextAction: 'Call setup_project_python_environment with the selected interpreter, environmentPath and packages. Do not search caches or try alternate download commands.' });
      const read = await Promise.all((args.readPaths ?? []).map((value: string) => canonicalProjectPath(workspace.root, value)));
      const write = await Promise.all((args.writePaths ?? []).map((value: string) => canonicalProjectPath(workspace.root, value)));
      write.forEach(value => this.checkWorkerWrite(chat, value));
      const readOnly = args.filesystemAccess === 'read-only' || (policy.mode === 1 && args.filesystemAccess !== 'workspace-write' && !write.length);
      const request: ProjectExecutionRequest = { command: args.command, cwd: target, mode: policy.mode, workspaceRoot: workspace.root, readableRoots: read,
        writableRoots: readOnly ? [] : worker ? await Promise.all(worker.ownedPaths.map(value => canonicalProjectPath(workspace.root, value))) : projectWritableRoots(policy.mode, workspace.root, [workspace.root, ...write]), network: args.network ?? 'deny', win32k: args.win32k ?? true, confined: Boolean(worker) || readOnly, loopback: name === 'start_project_server' };
      if (name === 'run_project_process') Object.assign(request, { executable: args.executable, args: args.args, stdin: args.stdin });
      const diagnosticOnly = ['answer', 'setup'].includes(ownerHandoff?.taskPolicy?.intent ?? '') || (ownerHandoff?.taskPolicy?.intent === 'debug' && !ownerHandoff.taskPolicy.diagnosis?.executionConfirmed);
      if (diagnosticOnly) { request.writableRoots = []; request.confined = true; }
      const planning = chat.collaborationMode === 'plan';
      if (planning) { request.writableRoots = []; request.confined = true; request.network = 'deny'; request.loopback = false; }
      const support = this.options.execution ? await this.options.execution.probe(request, signal) : { available: false };
      if (planning && !support.available) throw new ToolFailure('PLAN_MODE_SANDBOX_UNAVAILABLE', 'Read-only planning commands require verified native isolation. Use source-reading tools or leave Plan mode; unrestricted execution is unavailable while planning.');
      if ('version' in support) chat.executionSupport = support;
      const commandState = () => commandSnapshot(workspace.root, undefined, undefined, signal);
      const before = await commandState();
      const nativeFallback = !planning && ((requestedNative && (policy.mode !== 3 || request.confined)) || (!support.available && (policy.mode !== 3 || request.confined))) && !worker && Boolean(this.options.execution);
      const scopeInspection = await projectCommandApprovalReason(workspace.root, target, request, text => enforceCommandTaskScope(ownerHandoff?.taskPolicy, text, args.purpose), false);
      if (scopeInspection && ownerHandoff?.taskPolicy) throw new ToolFailure('TASK_SCOPE_INSPECTION_INCOMPLETE', `${scopeInspection} Task-scope inspection could not be completed; use a bounded, inspectable launch.`);
      const approvalReason = (nativeFallback ? 'Review this one-time command outside the sandbox. It will run with your user permissions.' : undefined) ??
        (ownerHandoff?.taskPolicy?.intent === 'debug' && !diagnosticOnly && !['test', 'build'].includes(args.purpose) ? 'Review this debugging command and its possible file/backend changes. Source edits must follow the recorded diagnosis; this command has workspace write access.' : undefined);
      const commandAction: ProjectAction = { kind: 'command', tool: name, command: args.command, cwd: target, paths: write, readOnly: request.writableRoots?.length === 0, network: request.network, approvalReason, contentHash: hash(JSON.stringify([before.digest, request]))! };
      const nativePermissions = 'Your user account filesystem and network access. Requested path and network limits cannot be enforced for this one-time command, including read-only diagnostic limits.';
      await this.authorize(chat, commandAction, signal, JSON.stringify({ ...request, sourceDigest: before.digest, justification: args.justification, sandboxReason: 'reason' in support ? support.reason : undefined, effectivePermissions: nativeFallback ? nativePermissions : policy.mode === 3 && !request.confined ? 'Your user account filesystem and network access.' : 'Verified isolation with the requested scope.', reason: approvalReason ?? 'Review command effects and requested filesystem/network scope.' }, null, 2), { isolationAvailable: support.available, reviewedNativeAvailable: nativeFallback });
      if ((policy.mode !== 3 || worker) && !support.available && !nativeFallback) throw new Error('Native confinement is unavailable for this command.');
      if (nativeFallback) { request.approvedNative = true; request.confined = false; }
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
        const execute = () => this.options.execution ? this.options.execution.execute(request, signal) : runCommand(args.command, target, signal, workspace.root);
        try {
          let failure: unknown;
          try { result = await execute(); }
          catch (error) {
            signal.throwIfAborted();
            failure = error;
            result = { exitCode: 1, output: error instanceof Error ? error.message : String(error), timedOut: false, confined: !request.approvedNative && (policy.mode !== 3 || Boolean(request.confined)) };
          }
          if (!planning && !worker && this.options.execution && !request.approvedNative && possibleSandboxConflict(result as ProjectExecutionResult)) {
            // A failed process may already have written files. Review the current
            // sources and the exact retry; never silently replay it outside isolation.
            this.commandResults.get(chat.id)?.push({ command: args.command, ...result });
            this.mutated(chat);
            const retryBefore = await commandState();
            const retryRequest = { ...request, approvedNative: true, confined: false };
            await this.authorize(chat, { ...commandAction, approvalReason: 'This command encountered a possible sandbox access restriction. Allow one retry with your user permissions?', contentHash: hash(JSON.stringify([retryBefore.digest, retryRequest]))! }, signal,
              JSON.stringify({ ...retryRequest, sourceDigest: retryBefore.digest, previousFailure: result.output.length > 3000 ? '[Earlier output omitted]\n' + result.output.slice(-3000) : result.output, warning: 'The first attempt may have partial effects. Retrying can repeat those effects.', effectivePermissions: nativePermissions }, null, 2), { reviewedNativeAvailable: true });
            const retryPolicy = this.context(chat);
            if (retryPolicy.mode !== policy.mode || retryPolicy.revision !== policy.revision) throw new ToolFailure('PERMISSION_CHANGED', 'Project permissions changed after review.');
            if (await resolve() !== target) throw new ToolFailure('WORKING_DIRECTORY_CHANGED', 'Working directory changed after review.');
            const retryReview = compareCommandSnapshots(retryBefore, await commandState());
            if (retryReview.state !== 'unchanged') throw new ToolFailure('SOURCE_CHANGED', 'Source files changed or could not be verified after retry review.', { changedPaths: retryReview.changedPaths });
            signal.throwIfAborted();
            result = await this.options.execution.execute(retryRequest, signal);
          } else if (failure) throw failure;
        } catch (error) { this.mutated(chat); throw error; } // Interrupted commands can leave partial writes.
        signal.throwIfAborted(); this.commandResults.get(chat.id)?.push({ command: args.command, ...result });
        let after;
        try { after = await commandState(); }
        catch (error) { this.mutated(chat); throw error; }
        const comparison = compareCommandSnapshots(before, after);
        const projectChanged = comparison.state === 'changed';
        if (comparison.state !== 'unchanged') this.mutated(chat);
        return { ...result, projectChanged, projectChange: comparison.state, verificationUnknown: comparison.state === 'unknown', changedPaths: comparison.changedPaths };
      });
    }
    let scopeReason: string | undefined;
    if (editing) {
      const before = await fs.readFile(target, 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return ''; throw error; });
      const after = name === 'patch_project_record' ? patchProjectRecord(before, args.variable, args.key, args.fields) : name === 'patch_project_file' ? before.replace(args.oldText, args.newText) : args.content;
      scopeReason = backendScopeReason(ownerHandoff?.taskPolicy, before, after);
    }
    const protectedRoots = editing ? await Promise.all(projectProtectedPaths(workspace.root).map(value => canonicalProjectPath(workspace.root, value))) : [];
    const action: ProjectAction = { kind: editing ? 'write' : 'read', paths: [target], ...(editing ? { contentHash: hash(JSON.stringify([args, ownerHandoff?.taskPolicy?.requestId, protectedRoots]))!, approvalReason: scopeReason } : {}) };
    await this.authorize(chat, action, signal, editing ? JSON.stringify({ operation: name === 'patch_project_record' ? 'Patch named catalog record fields' : name === 'patch_project_file' ? 'Patch unique text' : 'Replace entire text file', scopeReview: scopeReason, path: target, proposedContent: args.content, ...args }, null, 2) : undefined);
    if (await resolve() !== target) throw new Error('The target changed while permission was requested. Try again.');
    const root = within(workspace.root, target) ? workspace.root : path.parse(target).root;
    const relative = path.relative(root, target) || '.';
    if (name === 'list_project_files') return { files: await new Workspace(target).list('', 200, signal), limit: 200 };
    if (name === 'read_project_file' || name === 'read_project_record' || name === 'list_project_records') {
      const files = new Workspace(root);
      let result = name === 'list_project_records' ? await files.listRecords(relative, args.variable, args.offset, args.limit)
        : name === 'read_project_record' ? await files.readRecord(relative, args.variable, args.key) : await files.read(relative, args.start, args.end);
      signal.throwIfAborted();
      const currentPolicy = this.context(chat);
      if (currentPolicy.mode !== policy.mode || currentPolicy.revision !== policy.revision || await resolve() !== target)
        throw new Error('Project permissions or file identity changed during the read. Read the file again.');
      if (name === 'read_project_file') {
        const identity = JSON.stringify([workspace.root, currentPolicy.mode, currentPolicy.revision]);
        let cached = this.readCaches.get(chat.id);
        if (!cached || cached.policy !== identity) {
          cached = { policy: identity, projectId: chat.projectId!, cache: new ProjectReadCache() }; this.readCaches.set(chat.id, cached);
        }
        result = cached.cache.validated(target, result as Awaited<ReturnType<Workspace['read']>>);
      }
      const revision = randomUUID(); this.revisions.set(revision, { chatId: chat.id, target, hash: result.hash });
      if (this.revisions.size > 1000) this.revisions.delete(this.revisions.keys().next().value!);
      return { ...result, revision };
    }
    return this.withWorkspaceWrite(chat, async () => {
      signal.throwIfAborted();
      // Authorization and link targets must remain valid after waiting for the writer.
      if (await resolve() !== target) throw new Error('The file target changed before the edit.');
      if (JSON.stringify(await Promise.all(projectProtectedPaths(workspace.root).map(value => canonicalProjectPath(workspace.root, value)))) !== JSON.stringify(protectedRoots)) throw new ToolFailure('PROTECTED_PATHS_CHANGED', 'Protected project folders changed before the edit. Read the file and request the edit again.');
      const current = this.context(chat);
      if (current.mode !== policy.mode || current.revision !== policy.revision) throw new Error('Project permissions changed before this edit.');
      signal.throwIfAborted();
      const files = new Workspace(root);
      const change = name === 'patch_project_record' ? await files.patchRecord(relative, args.expectedHash, args.variable, args.key, args.fields) : name === 'patch_project_file' ? await files.patch(relative, args.expectedHash, args.oldText, args.newText) : await files.edit(relative, args.expectedHash, args.content, args.replacementIntent);
      this.mutated(chat);
      if (ownerHandoff && within(workspace.root, target)) {
        ownerHandoff.verificationTarget = await reconcileProjectTarget(workspace.root, ownerHandoff.verificationTarget?.entryPoint);
        ownerHandoff.requiresModelVerification = ownerHandoff.verificationTarget.kind === 'browser_model' || (ownerHandoff.verificationTarget.kind === 'unknown' && ownerHandoff.requiresModelVerification === true);
      }
      const nextHash = hash(change.after)!;
      if (hash(change.before) !== nextHash) {
        const receipts = this.editReceipts.get(chat.id) ?? new Map<string, string>();
        receipts.set(target, nextHash);
        if (receipts.size > 1000) receipts.delete(receipts.keys().next().value!);
        this.editReceipts.set(chat.id, receipts);
      }
      const revision = randomUUID(); this.revisions.set(revision, { chatId: chat.id, target, hash: nextHash });
      if (this.revisions.size > 1000) this.revisions.delete(this.revisions.keys().next().value!);
      return { path: change.path, previousHash: hash(change.before), hash: nextHash, revision, at: change.at, isolated: false };
    });
  }
}
