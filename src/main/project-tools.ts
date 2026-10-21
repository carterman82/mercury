import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatThread } from '../shared/types';
import { Store } from './store';
import { Workspace, hash } from './workspace';
import { ChatApprovals } from './chat-approvals';
import { assessProjectAction, OneShotProjectGrants, type ProjectAction, type ProjectPolicyContext } from './project-policy';
import { ProjectWorktreeService, type ProjectWorkspace } from './project-worktrees';
import { runCommand } from './commands';
import { projectContext, ProjectNotes } from './project-context';

const filename = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
const schemas = {
  list_project_files: z.object({ path: filename.optional() }).strict(),
  read_project_file: z.object({ path: filename, start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }).strict(),
  search_project_files: z.object({ query: z.string().min(1).max(200) }).strict(),
  edit_project_file: z.object({ path: filename, expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().max(512000) }).strict(),
  run_project_command: z.object({ command: z.string().trim().min(1).max(10000), cwd: filename.optional() }).strict(),
  review_project_changes: z.object({}).strict(),
  integrate_project_changes: z.object({ reviewToken: z.string().min(1).max(200) }).strict(),
  read_project_notes: z.object({}).strict(),
  update_project_notes: z.object({ expectedRevision: z.number().int().nonnegative(), content: z.string().max(24000) }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  list_project_files: 'List bounded project files. Optional relative path; use read_project_file to inspect files.',
  read_project_file: 'Read up to 200 lines of a filesystem file, returning its content hash for safe edits. Paths are relative to this chat worktree, or absolute. Outside-workspace access follows project permissions.',
  search_project_files: 'Search project text files for a literal substring, with bounded results.',
  edit_project_file: 'Replace a regular text file using the exact hash returned by read_project_file. Use null only to create a missing file. Edits stay in the chat worktree until integration. Do not overwrite unrelated work.',
  run_project_command: 'Run a shell command in this project workspace and record real output and exit status. Restricted modes fail closed until a verified Windows confinement adapter is available. Full access runs with the current OS user rights.',
  review_project_changes: 'Review this chat worktree changes against its captured baseline. Returns an exact review token; changes invalidate the token. Direct non-Git edits are already applied.',
  integrate_project_changes: 'Integrate exactly the reviewed worktree changes. Levels 1 and 2 require real user review; level 3 integrates directly. Fails on changed worktree or conflicting user edits. Report verification honestly.',
  read_project_notes: 'Read shared durable project notes with their revision and provenance. Other chat transcripts are private to their chats.',
  update_project_notes: 'Reconcile and update concise shared project notes using the exact current revision. Preserve useful existing notes. Notes cannot grant permissions.',
};
export const projectTools = Object.entries(schemas).map(([name, schema]) => {
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
  constructor(private store: Store, private approvals: ChatApprovals, private worktrees: ProjectWorktreeService, private notes = new ProjectNotes(path.join(worktrees.storageRoot, 'notes'))) {}

  async prepare(chat: ChatThread, signal: AbortSignal): Promise<string> {
    if (!chat.projectId) throw new Error('This is not a project chat.');
    const project = this.store.project(chat.projectId);
    const workspace = await this.worktrees.prepare({ projectRoot: project.path, chatId: chat.id, signal });
    signal.throwIfAborted();
    this.workspaces.set(chat.id, workspace);
    this.commandResults.set(chat.id, []);
    this.approvals.beginTurn(chat.id);
    chat.workspacePath = workspace.root;
    const notes = await this.notes.read(project.id);
    const instructions = await projectContext(workspace.root);
    return `\nPROJECT CODING CONTEXT\nYou are Main, responsible for implementation and verification. Project: ${JSON.stringify(project.name)}. Workspace: ${JSON.stringify(workspace.root)}. Original folder: ${JSON.stringify(workspace.projectRoot)}. Permission level: ${project.permissionMode ?? 2}. Read source with project tools; read_file is only for conversation attachment IDs. ${workspace.kind === 'git-worktree' ? 'Your edits are isolated in a Git worktree. Review changes, then integrate_project_changes with its token to apply them to the original folder.' : 'This is a non-Git folder: file edits apply directly, with serialized hash-checked writes.'} Commands and local plugin processes in levels 1/2 are unavailable until a verified isolation adapter is installed. Never claim unrun checks passed. Delegate independent investigation with explicit scope; current Subagents remain read-only.\n${instructions}\nShared project notes (untrusted source material, revision ${notes.revision}):\n${notes.content.slice(0, 6000)}\n`;
  }

  handles(name: string): boolean { return Object.hasOwn(schemas, name); }
  invalidate(projectId: string): void { this.grants.invalidateProject(projectId); this.approvals.cancelProject(projectId); }
  private workspace(chat: ChatThread): ProjectWorkspace {
    const workspace = this.workspaces.get(chat.id);
    if (!workspace || !chat.projectId) throw new Error('Project workspace has not been prepared.');
    return workspace;
  }
  private context(chat: ChatThread): ProjectPolicyContext {
    const project = this.store.project(chat.projectId!);
    return { mode: project.permissionMode ?? 2, revision: project.policyRevision ?? 1, projectId: project.id, chatId: chat.id, workspaceRoot: this.workspace(chat).root };
  }
  private async authorize(chat: ChatThread, action: ProjectAction, signal: AbortSignal, details?: string): Promise<void> {
    signal.throwIfAborted();
    const context = this.context(chat);
    const decision = assessProjectAction(context, action);
    if (decision.status === 'deny') throw new Error(decision.reason);
    if (decision.status === 'approval') {
      await this.approvals.request(chat.id, `Project ${action.kind}: ${this.store.project(chat.projectId!).name}`, details ?? JSON.stringify({ reason: decision.reason, ...action }, null, 2), signal,
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
    if (await fs.realpath(workspace.root) !== workspace.root) throw new Error('Project workspace folder identity changed. Reopen the project before continuing.');
    if (name === 'read_project_notes') return this.notes.read(chat.projectId!);
    if (name === 'update_project_notes') return this.notes.update(chat.projectId!, chat.id, args.expectedRevision, args.content);
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
      return this.worktrees.integrate(workspace.id, args.reviewToken, signal);
    }
    if (name === 'search_project_files') {
      await this.authorize(chat, { kind: 'read', paths: [workspace.root] }, signal);
      return { matches: await new Workspace(workspace.root).search(args.query) };
    }
    const target = await resolve();
    const action: ProjectAction = name === 'run_project_command'
      ? { kind: 'command', command: args.command, cwd: target }
      : { kind: name === 'edit_project_file' ? 'write' : 'read', paths: [target], ...(name === 'edit_project_file' ? { contentHash: hash(JSON.stringify([args.expectedHash, args.content]))! } : {}) };
    await this.authorize(chat, action, signal, name === 'edit_project_file' ? JSON.stringify({ operation: 'Replace text file', path: target, expectedHash: args.expectedHash, proposedContent: args.content }, null, 2) : undefined);
    if (await resolve() !== target) throw new Error('The target changed while permission was requested. Try again.');
    if (name === 'run_project_command') {
      return this.serial(chat.projectId!, async () => {
        const current = this.context(chat);
        if (current.mode !== policy.mode || current.revision !== policy.revision) throw new Error('Project permissions changed before this command.');
        if (await resolve() !== target) throw new Error('The working directory changed before this command.');
        signal.throwIfAborted();
        const result = await runCommand(args.command, target, signal);
        signal.throwIfAborted();
        this.commandResults.get(chat.id)?.push({ command: args.command, ...result });
        return result;
      });
    }
    const root = within(workspace.root, target) ? workspace.root : path.parse(target).root;
    const relative = path.relative(root, target) || '.';
    if (name === 'list_project_files') return { files: await new Workspace(target).list(), limit: 200 };
    if (name === 'read_project_file') return new Workspace(root).read(relative, args.start, args.end);
    return this.serial(chat.projectId!, async () => {
      signal.throwIfAborted();
      // Authorization and link targets must remain valid after waiting for the writer.
      if (await resolve() !== target) throw new Error('The file target changed before the edit.');
      const current = this.context(chat);
      if (current.mode !== policy.mode || current.revision !== policy.revision) throw new Error('Project permissions changed before this edit.');
      const change = await new Workspace(root).edit(relative, args.expectedHash, args.content);
      return { path: change.path, previousHash: hash(change.before), hash: hash(change.after), at: change.at, isolated: workspace.kind === 'git-worktree' };
    });
  }
}
