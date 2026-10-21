import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ProjectPolicyContext {
  mode: 1 | 2 | 3;
  revision: number;
  projectId: string;
  chatId: string;
  workspaceRoot: string;
}

/** Host-created action. Paths must be canonicalized, including existing parents,
 * immediately before assessment/execution. Models cannot provide risk assessments. */
export interface ProjectAction {
  kind: 'read' | 'write' | 'command' | 'plugin' | 'integrate';
  paths?: string[];
  command?: string;
  cwd?: string;
  /** Fingerprint all operation inputs/content (including plugin tool and arguments). */
  contentHash?: string;
  agentId?: string;
  destructive?: boolean;
}

export interface ProjectPolicyOptions {
  /** True only for a host adapter whose filesystem/descendant confinement is verified. */
  isolationAvailable?: boolean;
  /** Host proof of bounded effects, never a model claim or command-prefix allowlist. */
  boundedLowRisk?: boolean;
}

export interface ProjectPolicyDecision {
  status: 'allow' | 'approval' | 'deny';
  reason: string;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function assessProjectAction(context: ProjectPolicyContext, action: ProjectAction, options: ProjectPolicyOptions = {}): ProjectPolicyDecision {
  const decision = (status: ProjectPolicyDecision['status'], reason: string): ProjectPolicyDecision => ({ status, reason });
  if (![1, 2, 3].includes(context.mode) || !Number.isSafeInteger(context.revision) || context.revision < 0 || !context.projectId || !context.chatId || !path.isAbsolute(context.workspaceRoot)) {
    return decision('deny', 'Invalid project execution context.');
  }
  if (!['read', 'write', 'command', 'plugin', 'integrate'].includes(action.kind)) return decision('deny', 'Unknown project action.');
  if (action.paths?.some(target => !path.isAbsolute(target) || target.includes('\0')) || (action.cwd !== undefined && (!path.isAbsolute(action.cwd) || action.cwd.includes('\0')))) {
    return decision('deny', 'Project action paths must be canonical absolute paths.');
  }
  if ((action.kind === 'read' || action.kind === 'write') && !action.paths?.length) return decision('deny', 'Filesystem actions require explicit paths.');
  if (action.kind === 'command' && (!action.command?.trim() || !action.cwd)) return decision('deny', 'Commands require a command and working directory.');
  if (context.mode === 3) return decision('allow', 'Full access is enabled for this project.');
  if (action.kind === 'command' || action.kind === 'plugin') {
    if (!options.isolationAvailable) return decision('deny', 'Restricted execution is unavailable: no verified filesystem confinement adapter is installed. Approval cannot substitute unrestricted execution.');
    if (action.kind === 'plugin') return decision('approval', 'Review the plugin and its requested capabilities.');
    if (context.mode === 1 || !options.boundedLowRisk || action.destructive || !within(context.workspaceRoot, action.cwd!) || action.paths?.some(target => !within(context.workspaceRoot, target))) return decision('approval', 'This command requires review of its effects and scope.');
    return decision('allow', 'The host verified bounded command effects within the confined workspace.');
  }
  if (action.kind === 'integrate') return decision('approval', 'Review the combined changes and verification before integration.');
  if (action.destructive) return decision('approval', 'Destructive filesystem actions require review.');
  const outside = action.paths!.some(target => !within(context.workspaceRoot, target));
  if (outside && (action.kind === 'write' || context.mode === 1)) return decision('approval', 'Access outside the assigned workspace requires approval.');
  return decision('allow', action.kind === 'read' ? 'Reading is allowed by the project policy.' : 'Ordinary workspace edits are allowed by the project policy.');
}

function actionFingerprint(context: ProjectPolicyContext, action: ProjectAction): string {
  return createHash('sha256').update(JSON.stringify([
    context.projectId, context.chatId, context.mode, context.revision, context.workspaceRoot,
    action.kind, action.paths ?? [], action.command ?? null, action.cwd ?? null,
    action.contentHash ?? null, action.agentId ?? null, action.destructive ?? false,
  ])).digest('hex');
}

/** In-memory by design: grants never survive application restart or policy changes.
 * A grant is an exact one-shot approval, not a substitute for reassessing policy. */
export class OneShotProjectGrants {
  private grants = new Map<string, { projectId: string; fingerprint: string; expires: number }>();
  constructor(private now: () => number = Date.now, private lifetimeMs = 5 * 60_000) {
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) throw new Error('Approval lifetime must be positive.');
  }
  issue(context: ProjectPolicyContext, action: ProjectAction): string {
    this.prune();
    const id = randomUUID();
    this.grants.set(id, { projectId: context.projectId, fingerprint: actionFingerprint(context, action), expires: this.now() + this.lifetimeMs });
    return id;
  }
  consume(id: string, context: ProjectPolicyContext, action: ProjectAction, signal?: AbortSignal): boolean {
    const grant = this.grants.get(id);
    this.grants.delete(id);
    return !signal?.aborted && !!grant && grant.expires > this.now() && grant.fingerprint === actionFingerprint(context, action);
  }
  invalidateProject(projectId: string): void {
    for (const [id, grant] of this.grants) if (grant.projectId === projectId) this.grants.delete(id);
  }
  clear(): void { this.grants.clear(); }
  private prune(): void {
    for (const [id, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(id);
  }
}
