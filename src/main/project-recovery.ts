import { createHash } from 'node:crypto';
import { toolFailed, toolFailureCode } from './tool-outcome';
import { ProjectProgressObservations } from './project-progress-observations';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function commandFailureFamily(name: string, args: any, code: string) {
  if (!['run_project_command', 'run_project_process', 'start_project_server'].includes(name)) return undefined;
  // Permission/schema/source failures concern the tool and affected source, not
  // the spelling of a command. Ordinary command exits also need an operation
  // identity so independent failed checks are not mistaken for one retry loop.
  if (!/^COMMAND_EXIT_|^SCRIPT_SYNTAX$|^SHELL_COMMAND_UNAVAILABLE$/.test(code)) return undefined;
  const normalize = (text: string) => text.replace(/["'`]/g, '').replace(/\s+/g, '');
  const command = String(
    args.command ?? [args.executable, ...(Array.isArray(args.args) ? args.args : [])].filter(Boolean).join(' '),
  );
  if (code === 'SCRIPT_SYNTAX') {
    const script = command.match(/^\s*["']?([^\s"']+)["']?\s+(-e|-c|-command|-encodedcommand)\b/i);
    if (script) return normalize(script[1] + script[2]);
  }
  return (
    normalize(command) +
    (code.startsWith('COMMAND_EXIT_') && typeof args.stdin === 'string' ? ':' + fingerprint(normalize(args.stdin)) : '')
  );
}
/** Stable operation identity used to decide whether a successful retry resolves
 * a failed action. A successful unrelated command must not erase its blocker. */
export function projectActionIdentity(name: string, args: any, failureCode = 'COMMAND_EXIT_OPERATION') {
  args = args && typeof args === 'object' ? args : {};
  if (name === 'setup_project_python_environment') args = { ...args, environmentPath: args.environmentPath ?? '.venv_test' };
  const command = ['run_project_command', 'run_project_process', 'start_project_server'].includes(name);
  const target = String(args.path ?? args.destination ?? args.environmentPath ?? args.cwd ?? '.').replaceAll('\\', '/');
  return fingerprint([
    command ? 'project_command' : name,
    target,
    ...(['read_project_record', 'patch_project_record'].includes(name) ? [[args.variable, args.key]] : []),
    command
      ? commandFailureFamily(name, args, failureCode === 'SCRIPT_SYNTAX' ? failureCode : 'COMMAND_EXIT_OPERATION')
      : undefined,
  ]);
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
export class ProjectStalledError extends Error {}
export class ProjectStagnationError extends ProjectStalledError {}

export function verifiedPreviewRecovery(blocker: { name?: string; tool?: string; target: string } | undefined, name: string, target: string, result: any): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
  return Boolean(blocker && (blocker.name ?? blocker.tool) === 'start_project_server' && name === 'start_project_server' &&
    normalize(blocker.target) === normalize(target) && !toolFailed(result) && result?.running === true &&
    typeof result.id === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(result.url ?? ''));
}

type ProgressBlocker = { name: string; target: string; evidence: boolean; action?: string; failureCode?: string; failedArgs?: unknown; failureMessage?: string };
type HandoffBlocker = { tool: string; target: string; action?: string; code: string; sourceRevision?: string; message?: string };
type ResolutionContext<Blocker> = { blocker: Blocker; name: string; args: any; target: string; result: any; newEvidence: boolean };
type ProgressResolution = ResolutionContext<ProgressBlocker>;
type HandoffResolution = ResolutionContext<HandoffBlocker> & { failedArgs?: any };

function repairedPatchByFile({ blocker, name, target, result }: ProgressResolution): boolean {
  return blocker.name === 'patch_project_file' && ['patch_project_file', 'edit_project_file'].includes(name) &&
    target === blocker.target && typeof result?.hash === 'string' && result.previousHash !== result.hash;
}
function repairedPatchByProcess({ blocker, name, result }: ProgressResolution): boolean {
  return blocker.name === 'patch_project_file' && ['run_project_process', 'run_project_command'].includes(name) &&
    result?.projectChanged === true && Array.isArray(result.changedPaths) && result.changedPaths.some((value: unknown) => {
      if (typeof value !== 'string') return false;
      const normalized = value.replaceAll('\\', '/');
      return (process.platform === 'win32' ? normalized.toLowerCase() : normalized) === blocker.target;
    });
}
function recoveredPreview({ blocker, name, target, result }: ProgressResolution | HandoffResolution): boolean {
  return verifiedPreviewRecovery(blocker, name, target, result);
}
function freshRecoveryEvidence({ blocker, newEvidence }: ProgressResolution): boolean {
  return blocker.evidence && newEvidence;
}
function matchingProgressAction({ blocker, name, args }: ProgressResolution): boolean {
  return !blocker.evidence && Boolean(blocker.action) && blocker.action === projectActionIdentity(name, args, blocker.failureCode);
}
function matchingLegacyProgressTool({ blocker, name, target }: ProgressResolution): boolean {
  return !blocker.evidence && !blocker.action && blocker.name === name && blocker.target === target;
}
function matchingLegacyProgressProcess({ blocker, name, target }: ProgressResolution): boolean {
  return !blocker.evidence && !blocker.action && name === 'run_project_process' &&
    blocker.name === 'run_project_command' && blocker.target === target;
}
function correctedProgressOperation(context: ProgressResolution): boolean {
  const { blocker } = context;
  if (blocker.evidence || !blocker.failedArgs) return false;
  const repair: HandoffResolution = { ...context, blocker: {
    tool: blocker.name, target: blocker.target, code: blocker.failureCode ?? '', message: blocker.failureMessage,
  }, failedArgs: blocker.failedArgs };
  return correctedPreviewDirectory(repair) || correctedMissingGitPath(repair);
}

// Progress receives the observer's already-normalized target, including result.target.
// Verified patch/preview repairs take precedence over evidence/action fallbacks.
const progressResolutionRoutes: readonly ((context: ProgressResolution) => boolean)[] = [
  repairedPatchByFile, repairedPatchByProcess, recoveredPreview, correctedProgressOperation, freshRecoveryEvidence,
  matchingProgressAction, matchingLegacyProgressTool, matchingLegacyProgressProcess,
];
export function resolvesProgressBlocker(blocker: ProgressBlocker | undefined, name: string, args: any, target: string, result: any, newEvidence = false): boolean {
  if (!blocker || toolFailed(result)) return false;
  const context = { blocker, name, args, target, result, newEvidence };
  return progressResolutionRoutes.some(route => route(context));
}

function matchingHandoffAction({ blocker, name, args, target }: HandoffResolution): boolean {
  return blocker.target === target && (blocker.action
    ? blocker.action === projectActionIdentity(name, args, blocker.code)
    : blocker.tool === name);
}
function changedHandoffSource({ blocker, target, result, name, args }: HandoffResolution): boolean {
  if (['read_project_record', 'patch_project_record'].includes(blocker.tool) && blocker.action !== projectActionIdentity(name, args, blocker.code)) return false;
  return blocker.target === target && Boolean(result?.hash && result.hash !== blocker.sourceRevision);
}
function correctedPreviewDirectory({ blocker, name, args, target, result, failedArgs }: HandoffResolution): boolean {
  return blocker.code === 'SERVER_START_FAILED' && typeof failedArgs?.command === 'string' &&
    typeof args?.command === 'string' && failedArgs.command.trim().length > 0 && failedArgs.command.trim() === args.command.trim() &&
    verifiedPreviewRecovery({ ...blocker, target }, name, target, result);
}
// Only recognize a simple argv form. Shell composition and variable expansion
// need explicit verification rather than guessing that two commands are related.
function simpleCommandTokens(command: unknown): string[] | undefined {
  if (typeof command !== 'string') return undefined;
  const source = command.trim().replace(/\s+2>&1$/, '');
  if (/[&|;<>\r\n^`$%!]/.test(source)) return undefined;
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"']+)/gy;
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) return undefined;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    offset = pattern.lastIndex;
    if (offset < source.length && !/\s/.test(source[offset])) return undefined;
    while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++;
  }
  return tokens;
}
function correctedMissingGitPath({ blocker, name, args, target, result, failedArgs }: HandoffResolution): boolean {
  if (blocker.code !== 'COMMAND_EXIT_128' || blocker.target !== target || toolFailed(result) || result?.exitCode !== 0 ||
    !['run_project_command', 'run_project_process'].includes(blocker.tool) || name !== 'run_project_command') return false;
  const missing = blocker.message?.match(/^fatal: pathspec '([^'\r\n]+)' did not match any files\s*$/)?.[1];
  const before = simpleCommandTokens(failedArgs?.command), after = simpleCommandTokens(args.command);
  if (!missing || !before || !after || before[0] !== 'git' || before[1] !== 'add' ||
    after[0] !== 'git' || after[1] !== 'add' || before.slice(2).some(value => value.startsWith('-')) ||
    before.filter(value => value === missing).length !== 1) return false;
  const corrected = before.filter((value, index) => index < 2 || value !== missing);
  return corrected.length > 2 && JSON.stringify(corrected) === JSON.stringify(after);
}
const handoffResolutionRoutes: readonly ((context: HandoffResolution) => boolean)[] = [
  recoveredPreview, correctedPreviewDirectory, correctedMissingGitPath, matchingHandoffAction, changedHandoffSource,
];
/** Persisted blockers use raw argument targets. The caller owns failure/validation
 * branching: validation failures can still reach the action fallback here. */
export function resolvesHandoffBlocker(blocker: HandoffBlocker | undefined, name: string, args: any, target: string, result: any, failedArgs?: unknown): boolean {
  if (!blocker) return false;
  const context = { blocker, name, args, target, result, newEvidence: false, failedArgs };
  return handoffResolutionRoutes.some(route => route(context));
}

/** Per-response state: SDK/completion continuations cannot reset recovery allowance. */
export class ProjectProgress {
  private observations = new ProjectProgressObservations();
  private stagnantDecisions = 0;
  private stagnationRecovery = false;
  private calls: { failure?: string; read?: string }[] = [];
  private failures = new Map<string, number>();
  private evidence = new Set<string>();
  private duplicateReads = 0;
  private attempts = 0;
  private remaining = 120000;
  private running = false;
  private runningSince?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private blocker?: ProgressBlocker;
  private terminal?: ProjectStalledError;
  recoveries = 0;
  recoveryAt?: number;
  constructor(
    private options: {
      onStall?: (error: ProjectStalledError) => void;
      now?: () => number;
      providerLimitMs?: number;
      maxAttempts?: number;
      claimRecovery?: () => void;
      checkpoint?: () => string;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private stop(reason: string): never {
    const ErrorType = this.stagnationRecovery ? ProjectStagnationError : ProjectStalledError;
    const error = (this.terminal ??= new ErrorType(reason + ' Work is preserved; no model was switched.'));
    this.dispose();
    this.options.onStall?.(error);
    throw error;
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.blocker && this.running) {
      this.runningSince = this.now();
      this.timer = setTimeout(
        () => {
          try {
            this.stop('Recovery exceeded two minutes of provider time without resolving its blocker.');
          } catch {
            /* Abort is delivered through onStall; next boundary throws too. */
          }
        },
        Math.max(0, this.remaining),
      );
    }
  }
  providerState(state: 'queued' | 'running' | 'idle') {
    if (this.runningSince !== undefined) this.remaining -= Math.max(0, this.now() - this.runningSince);
    this.runningSince = undefined;
    this.running = state === 'running';
    if (this.terminal) throw this.terminal;
    if (this.blocker && this.remaining <= 0)
      this.stop('Recovery exceeded two minutes of provider time without resolving its blocker.');
    this.schedule();
  }
  attempt() {
    if (this.terminal) throw this.terminal;
    if (this.blocker && ++this.attempts > (this.options.maxAttempts ?? 8))
      this.stop('Recovery exceeded eight further tool attempts without resolving its blocker.');
  }
  recover(
    reason: string,
    name = 'completion',
    target = '.',
    evidence = false,
    operation?: { action: string; failureCode: string; failedArgs?: unknown; failureMessage?: string },
  ): string {
    if (this.terminal) throw this.terminal;
    if (this.recoveries) this.stop(reason + ' after one recovery attempt.');
    try { this.options.claimRecovery?.(); }
    catch (error) { this.stop(error instanceof Error ? error.message : 'The shared recovery allowance was exhausted.'); }
    this.recoveries++;
    this.recoveryAt = this.now();
    this.remaining = this.options.providerLimitMs ?? 120000;
    this.attempts = 0;
    this.blocker = { name, target, evidence, ...operation };
    this.calls = [];
    this.failures.clear();
    this.duplicateReads = 0;
    this.schedule();
    return (
      'MERCURY RECOVERY (one attempt, at most two minutes of provider time / eight tool attempts): ' +
      reason +
      '. Reuse saved evidence, resolve the recorded blocker with a different approach, or report it. Use patch_project_file and run_project_process for source changes. Narration is not progress.'
    );
  }
  observe(name: string, args: any, result: any): string | undefined {
    if (this.terminal) throw this.terminal;
    args = args && typeof args === 'object' ? args : {};
    let target = String(result?.target ?? args.path ?? args.destination ?? args.environmentPath ?? args.cwd ?? '.').replaceAll('\\', '/');
    if (process.platform === 'win32') target = target.toLowerCase();
    const entry: { failure?: string; read?: string } = {};
    const failed = toolFailed(result);
    const progress = this.observations.observe(name, args, result);
    if (progress) {
      this.stagnantDecisions = 0;
      if (this.stagnationRecovery) {
        this.blocker = undefined; this.stagnationRecovery = false;
        this.runningSince = undefined;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
      }
    } else this.stagnantDecisions++;
    let failureCode: string | undefined;
    if (failed) {
      const code = toolFailureCode(result);
      failureCode = String(code);
      entry.failure = fingerprint([
        name,
        target,
        code,
        result?.sourceRevision ?? 'unknown',
        commandFailureFamily(name, args, code),
        ...(['read_project_record', 'patch_project_record'].includes(name) ? [[args.variable, args.key]] : []),
      ]);
      this.failures.set(entry.failure, (this.failures.get(entry.failure) ?? 0) + 1);
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
    } else if (name !== 'read_project_file' && /^(read_|list_|search_|query_|recall_)/.test(name)) {
      const clean = (value: any): any =>
        Array.isArray(value)
          ? value.map(clean)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value)
                  .filter(
                    ([key]) => !['revision', 'evidenceId', 'at', 'observedAt', 'updatedAt', 'durationMs'].includes(key),
                  )
                  .map(([key, item]) => [key, clean(item)]),
              )
            : value;
      entry.read = fingerprint([
        name,
        target,
        name === 'read_project_file'
          ? [result?.hash, result?.startLine ?? args.start ?? 1, result?.endLine ?? args.end ?? 200, result?.content]
          : [stable(args), clean(result)],
      ]);
    }
    if (
      (!failed &&
        ['patch_project_file', 'patch_project_record', 'edit_project_file', 'download_project_asset'].includes(name) &&
        typeof result?.hash === 'string' &&
        result.previousHash !== result.hash) ||
      result?.projectChanged === true
    ) {
      this.calls = [];
      this.failures.clear();
      this.evidence.clear();
      this.duplicateReads = 0;
    }
    const newEvidence = Boolean(entry.read && !this.evidence.has(entry.read));
    if (entry.read) {
      // Cached reads don't count toward duplicate detection
      const isCachedRead = result?.readReuse?.kind === 'validated-cache';
      if (!isCachedRead) {
        this.duplicateReads = newEvidence ? 0 : this.duplicateReads + 1;
        this.evidence.add(entry.read);
      }
    }
    if (this.evidence.size > 512) this.evidence.delete(this.evidence.values().next().value!);
    const resolved = resolvesProgressBlocker(this.blocker, name, args, target, result, newEvidence);
    if (resolved) {
      this.blocker = undefined;
      this.runningSince = undefined;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.calls.push(entry);
    this.calls = this.calls.slice(-12);
    const failureLoop = entry.failure && (this.failures.get(entry.failure) ?? 0) >= 3;
    const readLoop =
      entry.read && (this.calls.filter((call) => call.read === entry.read).length >= 3 || this.duplicateReads >= 6);
    if (failureLoop || readLoop)
      return this.recover(
        failureLoop ? 'Repeated failing ' + name + ' action' : 'Repeated reads of unchanged evidence',
        name,
        target,
        Boolean(readLoop),
        failureCode ? {
          action: projectActionIdentity(name, args, failureCode), failureCode,
          // Ephemeral provenance for the same conservative corrected-operation
          // routes used by durable handoff recovery. Never persisted in tasks.
          failedArgs: { command: args.command },
          failureMessage: String(result?.error ?? result?.output ?? '').slice(0, 1200),
        } : undefined,
      );
    if (this.blocker && this.attempts >= (this.options.maxAttempts ?? 8))
      this.stop('Recovery exhausted eight further tool attempts without resolving its blocker.');
    if (this.stagnantDecisions >= 8) {
      this.stagnationRecovery = true;
      const recovery = this.recover('No meaningful task progress after eight tool decisions', 'stagnation');
      this.stagnantDecisions = 0;
      return recovery + (this.options.checkpoint ? '\n' + this.options.checkpoint() : '');
    }
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.runningSince = undefined;
  }
}

