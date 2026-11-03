import { createHash } from 'node:crypto';
import type { ProjectHandoff } from '../shared/types';
import { toolFailed, toolFailureCode } from './tool-outcome';
import { z } from 'zod';
import type { SourceEvidence } from '../shared/types';
import { ToolFailure } from './tool-outcome';

const compatibilitySourceTools = new Set(['read_project_file', 'read_file', 'web_fetch', 'browser_read', 'browser_open']);

const requirementSchema = z
  .object({
    id: z.string().max(100).optional(),
    text: z.string().min(1).max(4000),
    status: z.enum(['passed', 'failed', 'blocked', 'not_run']),
    verification: z.enum(['inspection', 'command', 'browser']),
    evidenceIds: z.array(z.string().max(200)).max(20).describe('Use [] for not_run criteria. Passed criteria need exact evidenceId values from successful tool results; never invent IDs.'),
    stage: z.enum(['page', 'model', 'inference']).describe('For browser model work, supply three separate browser criteria with stage page, model, and inference. IDs and text do not replace this field.').optional(),
    selector: z.string().min(1).max(500).optional(),
    expectedText: z.string().min(1).max(1000).optional(),
  })
  .strict();
const taskSchema = z
  .object({
    requirements: z.array(requirementSchema).max(20).describe('Only new criteria or status updates. Use [] for a compatibility-only or remaining-work update; all existing criteria are retained.'),
    remaining: z.string().max(4000),
    compatibility: z
      .object({
        runtime: z.string().min(1).max(200),
        version: z.string().min(1).max(100),
        modelFormat: z.enum(['gguf', 'onnx', 'mlc']),
        modelId: z.string().min(1).max(300),
        maxBytes: z.number().int().min(1).max(1073741824),
        evidenceIds: z.array(z.string().max(200)).min(1).max(10),
      })
      .strict()
      .optional(),
    compatibilityCorrection: z.string().trim().min(1).max(1000).describe('Reason for a documented runtime version correction. Requires a new successful source observation; runtime, model, layout and byte limit stay fixed. Invalidates prior verification.').optional(),
  })
  .strict();
const { $schema: _schema, ...parameters } = z.toJSONSchema(taskSchema);
export const projectTaskTool = {
  type: 'function',
  function: {
    name: 'update_project_task',
    description:
      'Persist concrete acceptance requirements and actual verification status. Send only NEW criteria or status updates; omitted original criteria are retained automatically. Do not repeat or reword the whole saved handoff. requirements must be a JSON array, remaining a separate string field. Preserve original requirements; placeholders cannot satisfy real behavior. Evidence IDs come from saved tool observations/recall_context. Browser verification requires fresh open, interaction and observation after edits; command checks need successful exit. Set blocked/failed/not_run honestly.',
    parameters,
  },
};
export const projectTaskReadTool = {
  type: 'function', function: {
    name: 'read_project_task',
    description: 'Read this chat\'s saved objective, exact acceptance criteria/IDs, compatibility, verification and current blocker. Task state is separate from shared project notes. Use before updating criteria; do not reread source files to recover task state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export function readProjectTask(handoff: ProjectHandoff) {
  return { objective: handoff.objective, requirements: handoff.requirements, compatibility: handoff.compatibility,
    remaining: handoff.remaining, generation: handoff.generation, blocker: handoff.blocker,
    browser: handoff.browser, nextAction: 'Send only new criteria/status updates. A compatibility-only repair uses requirements:[]; unchanged criteria are retained automatically.' };
}

export const projectTaskInstructions = `\nPROJECT DELIVERY CONTRACT\nBefore edits, commands or implementation assignments, call update_project_task to record concrete acceptance criteria for implementation requests. Preserve explicit user requirements across follow-ups; a resume message does not replace them. For browser model work include compatibility:{runtime,version,modelFormat,modelId,maxBytes,evidenceIds} from inspected runtime sources/docs, plus three browser criteria stage:page, stage:model with selector/expectedText for the ready indicator, and stage:inference. Transformers.js expects modelFormat:onnx; WebLLM expects modelFormat:mlc (JSON manifests, binary weight shards and WASM runtime). GGUF needs a verified GGUF-capable browser runtime. Use exact evidenceId values from successful tool results, never invented IDs. Unverified requirements use status:not_run and evidenceIds:[]. A fallback/demo/canned reply does not satisfy requested real model inference. Prefer incremental patches to large rewrites. Record requirements as passed only with current successful evidence. For website functional checks: reload after edits, inspect script errors, mark the model-ready criterion passed, submit a question with browser_fill responseSelector, then browser_read with that response selector to observe a NEW reply/result. Opening a page alone is not testing it. If blocked, state changed versus unverified behavior. Do not announce completion while requirements remain blocked, failed or not run.\n`;

export function updateProjectTask(handoff: ProjectHandoff, raw: unknown, evidence: SourceEvidence[]) {
  const value = taskSchema.parse(raw);
  let versionCorrected = false;
  if (value.compatibilityCorrection && (!handoff.compatibility || !value.compatibility || handoff.compatibility.version === value.compatibility.version))
    throw new ToolFailure('COMPATIBILITY_CORRECTION_REQUIRED', 'A correction reason requires an existing compatibility record and a changed runtime version supported by new source evidence.');
  if (value.compatibility) {
    if ((value.compatibility.modelFormat !== 'onnx' && /transformers/i.test(value.compatibility.runtime)) ||
        (value.compatibility.modelFormat !== 'mlc' && /web[-\s]?llm/i.test(value.compatibility.runtime)))
      throw new ToolFailure(
        'MODEL_RUNTIME_MISMATCH',
        'Transformers.js uses ONNX; WebLLM uses MLC model layouts. A GGUF asset needs a verified GGUF-capable browser runtime. Verify the pinned runtime documentation before implementation.',
      );
    const invalidEvidenceIds = value.compatibility.evidenceIds.filter(
        (id) =>
          !evidence.some(
            (item) =>
              item.id === id &&
              compatibilitySourceTools.has(item.tool) &&
              !toolFailed(safeResult(item.result)),
          ),
      );
    if (invalidEvidenceIds.length)
      throw new ToolFailure(
        'COMPATIBILITY_EVIDENCE_REQUIRED',
        'Compatibility needs successful source or documentation observations. Use the exact evidenceId returned by a successful read or fetch; recall_context can recover saved observations.',
        { invalidEvidenceIds, availableSources: evidence.filter(item => compatibilitySourceTools.has(item.tool) && !toolFailed(safeResult(item.result))).slice(-12).map(item => ({ evidenceId: item.id, tool: item.tool, label: item.label, input: item.input.slice(0, 500) })) },
      );
    versionCorrected = Boolean(handoff.compatibility && value.compatibilityCorrection &&
      handoff.compatibility.version !== value.compatibility.version &&
      value.compatibility.evidenceIds.some(id => !handoff.compatibility!.evidenceIds.includes(id)));
    if (
      handoff.compatibility &&
      ['runtime', 'version', 'modelFormat', 'modelId', 'maxBytes'].some(
        (key) => (key !== 'version' || !versionCorrected) && (handoff.compatibility as any)[key] !== (value.compatibility as any)[key],
      )
    )
      throw new ToolFailure(
        'COMPATIBILITY_SCOPE_CHANGED',
        'Do not silently replace the recorded runtime/model or relax its byte limit. A runtime version repair needs compatibilityCorrection with a reason and new successful source evidence; preserve the runtime, model, layout and byte limit.',
      );
  }
  for (const requirement of value.requirements) {
    const prior = handoff.requirements.find(
      (item) => (requirement.id && item.id === requirement.id) || item.text === requirement.text,
    );
    if (
      prior &&
      (prior.verification !== requirement.verification ||
        prior.stage !== requirement.stage ||
        prior.text !== requirement.text ||
        prior.selector !== requirement.selector ||
        prior.expectedText !== requirement.expectedText)
    )
      throw new ToolFailure(
        'REQUIREMENT_CHANGED',
        'Existing acceptance criteria and verification types cannot be weakened or reworded.',
      );
    requirement.id = prior?.id ?? fingerprint(requirement.text).slice(0, 24);
    if (requirement.status !== 'passed') continue;
    const observations = requirement.evidenceIds.map((id) => evidence.find((item) => item.id === id));
    if (
      !observations.length ||
      observations.some(
        (item) =>
          !item || (item.projectRevision ?? 0) !== (handoff.generation ?? 0) || item.at < (handoff.lastMutationAt ?? 0),
      )
    )
      throw new ToolFailure('VERIFICATION_EVIDENCE_REQUIRED', 'Passed requirements need current evidence IDs from after the last edit/command.', {
        requirementId: requirement.id, verification: requirement.verification, stage: requirement.stage,
        nextAction: 'Read or test the current source after edits, then cite the exact evidenceId from that successful observation. A write hash is not an evidence ID.',
      });
    if (
      requirement.verification === 'browser' &&
      (!handoff.browser ||
        handoff.browser.errors?.length ||
        (!requirement.stage && (!handoff.browser.interacted || !handoff.browser.observed)))
    )
      throw new ToolFailure('BROWSER_EVIDENCE_REQUIRED',
        'Browser verification needs a fresh page open, relevant interaction and subsequent observation without script errors after changes.',
        { requirementId: requirement.id, stage: requirement.stage, needsFreshOpen: !handoff.browser,
          needsInteraction: !handoff.browser?.interacted, needsObservation: !handoff.browser?.observed,
          scriptErrors: handoff.browser?.errors ?? [],
          nextAction: 'After the interaction, call browser_read, not only browser_wait. For inference, first observe and mark the model-ready criterion passed; then browser_fill with a responseSelector identifying only the assistant reply, and browser_read with that same selector after generation. Preserve the existing criteria.',
        },
      );
    for (const item of observations) {
      let result: unknown;
      try {
        result = JSON.parse(item!.result);
      } catch {
        throw new Error('Verification requires structured successful tool evidence.');
      }
      if (toolFailed(result)) throw new Error('Failed tool results cannot establish a passed requirement.');
    }
    if (
      requirement.verification === 'command' &&
      !observations.some((item) => ['run_project_command', 'run_project_process'].includes(item!.tool))
    )
      throw new Error('Command verification requires an actual successful recorded command.');
    if (
      requirement.verification === 'browser' &&
      !observations.some((item) => ['browser_open', 'browser_read', 'browser_screenshot'].includes(item!.tool))
    )
      throw new ToolFailure('BROWSER_OBSERVATION_REQUIRED', 'Browser verification requires the post-interaction observation evidence.', {
        requirementId: requirement.id, stage: requirement.stage,
        nextAction: requirement.stage === 'model'
          ? `While the model is still loaded, call browser_read with selector ${requirement.selector}. Cite that result's evidenceId to mark ONLY this model criterion passed BEFORE submitting any chat question. browser_wait is not the required selected observation. Do not reopen the page.`
          : 'Call browser_read after the interaction and cite its exact evidenceId. For inference use the same responseSelector supplied to browser_fill. Do not reopen the page.',
      });
    if (
      requirement.verification === 'browser' &&
      !requirement.evidenceIds.includes(handoff.browser?.observationId ?? '')
    )
      throw new ToolFailure('BROWSER_OBSERVATION_STALE', 'Use the current page’s post-interaction observation evidence ID.', {
        requirementId: requirement.id, stage: requirement.stage,
        observationId: handoff.browser?.observationId,
        nextAction: 'Cite the current browser_read observation evidenceId. If no selected observation has been made, call browser_read with the criterion selector before updating this criterion. Preserve the loaded page.',
      });
    if (requirement.stage && requirement.verification !== 'browser')
      throw new ToolFailure('VERIFICATION_KIND', 'Page/model/inference stages require browser verification.');
    if (requirement.status === 'passed' && requirement.stage === 'model') {
      const selected = handoff.browser?.selected;
      if (
        !requirement.selector ||
        !requirement.expectedText ||
        selected?.selector !== requirement.selector ||
        !selected.text.includes(requirement.expectedText) ||
        /loading|fallback|not loaded|no (?:real )?model|sample|failed|error|placeholder/i.test(selected.text)
      )
        throw new ToolFailure(
          'MODEL_NOT_READY',
          'Observe the explicit loaded-model indicator using browser_read selector; loading/fallback/error text is not ready.',
        );
    }
    if (
      requirement.status === 'passed' &&
      requirement.stage === 'inference' &&
      (!handoff.browser?.readyAtInteraction ||
        !handoff.browser.submitted ||
        !handoff.browser.responseSelector ||
        !handoff.browser.replyAfter?.trim() ||
        handoff.browser.replyAfter === handoff.browser.replyBefore ||
        /fallback|sample reply|no model|model load failed|^\s*(?:thinking|loading|generating|processing|pending|please wait|error\b|failed\b)/i.test(
          handoff.browser.replyAfter,
        ))
    )
      throw new ToolFailure(
        'INFERENCE_NOT_VERIFIED',
        'Inference needs a loaded-model observation, a submitted test question and a new response observed afterward.',
      );
  }
  // Retain omitted original requirements rather than silently downgrading scope.
  const merged = [
    ...handoff.requirements.filter((previous) => !value.requirements.some((next) => next.text === previous.text)),
    ...value.requirements,
  ];
  if (merged.length > 40)
    throw new ToolFailure(
      'REQUIREMENT_LIMIT',
      'Keep at most 40 acceptance criteria; existing criteria are never silently discarded.',
    );
  handoff.requirements = merged;
  if (versionCorrected) {
    handoff.generation = (handoff.generation ?? 0) + 1;
    handoff.lastMutationAt = Date.now();
    handoff.browser = undefined;
    handoff.requirements = merged.map(requirement => ({ ...requirement, status: 'not_run', evidenceIds: [] }));
  }
  if (value.compatibility) handoff.compatibility = value.compatibility;
  if (value.requirements.some((item) => item.stage === 'model' && item.status === 'passed') && handoff.browser)
    handoff.browser.modelReady = true;
  handoff.remaining = value.remaining;
  handoff.updatedAt = Date.now();
  const missingStages = handoff.requiresModelVerification
    ? ['page','model','inference'].filter(stage => !handoff.requirements.some(item => item.stage === stage && item.verification === 'browser'))
    : [];
  const implementationReady = handoff.requirements.length > 0 && (!handoff.requiresModelVerification || Boolean(handoff.compatibility));
  return { ...handoff, implementationReady, verificationReady: implementationReady && !missingStages.length, missingStages, ...(!handoff.requirements.length ? {
    nextAction: 'Before implementation, add concrete acceptance criteria with update_project_task. A metadata-only update does not create a delivery contract.',
  } : !implementationReady ? {
    nextAction: 'Before implementation, call update_project_task again. Supply compatibility from successful source evidence and ADD separate requirements with stage:"page", stage:"model", stage:"inference", verification:"browser", status:"not_run", evidenceIds:[]. Model stage needs selector and expectedText for the ready indicator. Preserve existing requirements unchanged.',
  } : missingStages.length ? { nextAction: 'Implementation may proceed with the documented model compatibility. Before final delivery add separate browser criteria with stage:"page", stage:"model", and stage:"inference" and verify them; existing criteria must be preserved.' } : {}) };
}
function safeResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Unstructured observation' };
  }
}

export function requireProjectContract(handoff: ProjectHandoff | undefined, delivery = false) {
  if (!handoff?.requirements.length)
    throw new ToolFailure(
      'NEED_TASK_CONTRACT',
      'Record concrete acceptance criteria with update_project_task before changing the project or running commands. No action was executed.',
    );
  if (
    handoff.requiresModelVerification &&
    (!handoff.compatibility ||
      (delivery && !['page', 'model', 'inference'].every((stage) =>
        handoff.requirements.some((item) => item.stage === stage && item.verification === 'browser'),
      )))
  )
    throw new ToolFailure(
      'MODEL_CONTRACT_REQUIRED',
      'Browser model work requires documented runtime/format compatibility and explicit stage fields before implementation. Call update_project_task with compatibility:{runtime,version,modelFormat,modelId,maxBytes,evidenceIds} and three separate requirements with verification:"browser", status:"not_run", evidenceIds:[], and stage:"page", stage:"model", stage:"inference" respectively. The model stage also needs selector and expectedText for the ready indicator. Requirement IDs or wording do not replace the stage field. Preserve the other requirements. No action was executed.',
      { missingCompatibility: !handoff.compatibility, missingStages: ['page','model','inference'].filter(stage => !handoff.requirements.some(item => item.stage === stage && item.verification === 'browser')) },
    );
}

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
  const command = ['run_project_command', 'run_project_process', 'start_project_server'].includes(name);
  const target = String(args.path ?? args.destination ?? args.cwd ?? '.').replaceAll('\\', '/');
  return fingerprint([
    command ? 'project_command' : name,
    target,
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

export function verifiedPreviewRecovery(blocker: { name?: string; tool?: string; target: string } | undefined, name: string, target: string, result: any): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
  return Boolean(blocker && (blocker.name ?? blocker.tool) === 'start_project_server' && name === 'start_project_server' &&
    normalize(blocker.target) === normalize(target) && !toolFailed(result) && result?.running === true &&
    typeof result.id === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(result.url ?? ''));
}

/** Per-response state: SDK/completion continuations cannot reset recovery allowance. */
export class ProjectProgress {
  private calls: { failure?: string; read?: string }[] = [];
  private failures = new Map<string, number>();
  private evidence = new Set<string>();
  private duplicateReads = 0;
  private attempts = 0;
  private remaining = 120000;
  private running = false;
  private runningSince?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private blocker?: { name: string; target: string; evidence: boolean; action?: string; failureCode?: string };
  private terminal?: ProjectStalledError;
  recoveries = 0;
  recoveryAt?: number;
  constructor(
    private options: {
      onStall?: (error: ProjectStalledError) => void;
      now?: () => number;
      providerLimitMs?: number;
      maxAttempts?: number;
    } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private stop(reason: string): never {
    const error = (this.terminal ??= new ProjectStalledError(reason + ' Work is preserved; no model was switched.'));
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
    operation?: { action: string; failureCode: string },
  ): string {
    if (this.terminal) throw this.terminal;
    if (this.recoveries) this.stop(reason + ' after one recovery attempt.');
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
    let target = String(result?.target ?? args.path ?? args.destination ?? args.cwd ?? '.').replaceAll('\\', '/');
    if (process.platform === 'win32') target = target.toLowerCase();
    const entry: { failure?: string; read?: string } = {};
    const failed = toolFailed(result);
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
      ]);
      this.failures.set(entry.failure, (this.failures.get(entry.failure) ?? 0) + 1);
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!);
    } else if (/^(read_|list_|search_|query_|recall_)/.test(name)) {
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
        ['patch_project_file', 'edit_project_file', 'download_project_asset'].includes(name) &&
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
      this.duplicateReads = newEvidence ? 0 : this.duplicateReads + 1;
      this.evidence.add(entry.read);
    }
    if (this.evidence.size > 512) this.evidence.delete(this.evidence.values().next().value!);
    // A failed source patch may be repaired by a structured process. Only a
    // verified mutation of that same file resolves it; unrelated edits do not.
    const repairedPatchTarget = this.blocker?.name === 'patch_project_file' && !failed && (
      (['patch_project_file', 'edit_project_file'].includes(name) && target === this.blocker.target &&
        typeof result?.hash === 'string' && result.previousHash !== result.hash) ||
      (['run_project_process', 'run_project_command'].includes(name) && result?.projectChanged === true &&
        Array.isArray(result.changedPaths) && result.changedPaths.some((value: unknown) => {
          if (typeof value !== 'string') return false;
          const normalized = value.replaceAll('\\', '/');
          return (process.platform === 'win32' ? normalized.toLowerCase() : normalized) === this.blocker!.target;
        }))
    );
    const resolved =
      this.blocker &&
      !failed &&
      (repairedPatchTarget || verifiedPreviewRecovery(this.blocker, name, target, result) || (this.blocker.evidence
        ? newEvidence
        : this.blocker.action
          ? this.blocker.action === projectActionIdentity(name, args, this.blocker.failureCode)
          : (this.blocker.name === name && this.blocker.target === target) ||
            (name === 'run_project_process' &&
              this.blocker.name === 'run_project_command' &&
              this.blocker.target === target)));
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
        failureCode ? { action: projectActionIdentity(name, args, failureCode), failureCode } : undefined,
      );
    if (this.blocker && this.attempts >= (this.options.maxAttempts ?? 8))
      this.stop('Recovery exhausted eight further tool attempts without resolving its blocker.');
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.runningSince = undefined;
  }
}

export function newHandoff(previous: ProjectHandoff | undefined, request: string): ProjectHandoff {
  return {
    objective: previous?.objective ?? request.slice(0, 4000),
    requiresModelVerification:
      previous?.requiresModelVerification ??
      /\bgguf\b|\bonnx\b|local model|model.{0,120}browser|browser.{0,120}(?:model|inference)/i.test(request),
    compatibility: previous?.compatibility,
    generation: previous?.generation,
    snapshots: previous?.snapshots,
    requirements: previous?.requirements ?? [],
    reads: previous?.reads ?? [],
    changedPaths: previous?.changedPaths ?? [],
    checks: previous?.checks ?? [],
    completedSteps: previous?.completedSteps ?? [],
    remaining: request.slice(0, 4000),
    updatedAt: Date.now(),
  };
}

export function recordProjectAction(
  handoff: ProjectHandoff,
  name: string,
  args: any,
  result: any,
  evidenceId?: string,
  at = Date.now(),
) {
  handoff.updatedAt = at;
  if (name === 'read_project_file' && !toolFailed(result)) {
    handoff.reads = [
      ...handoff.reads.filter(
        (read) => read.path !== args.path || read.startLine !== (result.startLine ?? args.start ?? 1),
      ),
      {
        path: args.path,
        hash: result.hash,
        startLine: result.startLine ?? args.start ?? 1,
        endLine: result.endLine ?? args.end ?? 200,
      },
    ].slice(-50);
  }
  const mutation =
    (['patch_project_file', 'edit_project_file', 'download_project_asset'].includes(name) && !toolFailed(result)) ||
    (['run_project_command', 'run_project_process'].includes(name) && result.projectChanged === true);
  if (mutation || result?.verificationUnknown) {
    if (result.path && result.hash) {
      handoff.reads = handoff.reads.filter((read) => read.path !== args.path);
      handoff.snapshots = [
        ...(handoff.snapshots ?? []).filter((item) => item.path !== result.path),
        { path: result.path, hash: result.hash },
      ].slice(-100);
    }
    if (result.path) handoff.changedPaths = [...new Set([...handoff.changedPaths, result.path])].slice(-100);
    handoff.lastMutationAt = at;
    handoff.generation = (handoff.generation ?? 0) + 1;
    // Prior browser observations cannot verify a new revision.
    handoff.browser = undefined;
    for (const requirement of handoff.requirements) if (requirement.status === 'passed') requirement.status = 'not_run';
    if (!toolFailed(result) && mutation)
      handoff.completedSteps = [
        ...handoff.completedSteps,
        `${name}: ${result.path ?? args.command ?? args.executable}`.slice(0, 300),
      ].slice(-30);
  }
  if (['run_project_command', 'run_project_process'].includes(name))
    handoff.checks = [
      ...handoff.checks,
      {
        name: String(args.command ?? args.executable).slice(0, 500),
        status: toolFailed(result) ? ('failed' as const) : ('passed' as const),
        at: Date.now(),
        evidenceId,
      },
    ].slice(-40);
  if (name.startsWith('browser_') && !toolFailed(result)) {
    if (name === 'browser_open')
      handoff.browser = {
        url: result.url,
        openedAt: at,
        interacted: false,
        observed: false,
        observationId: evidenceId,
      };
    if (handoff.browser && ['browser_pointer', 'browser_press', 'browser_fill', 'browser_click_button', 'browser_act'].includes(name)) {
      handoff.browser.interacted = true;
      handoff.browser.interactedAt = at;
      handoff.browser.observed = false;
      handoff.browser.observationId = undefined;
      handoff.browser.readyAtInteraction = handoff.browser.modelReady;
      if (name === 'browser_fill') {
        handoff.browser.submitted = result.submitted === true;
        handoff.browser.responseSelector = result.responseSelector;
        handoff.browser.replyBefore = result.replyBefore;
        handoff.browser.replyAfter = undefined;
      }
    }
    if (
      handoff.browser?.interacted &&
      ['browser_read', 'browser_screenshot'].includes(name) &&
      result.url === handoff.browser.url
    ) {
      handoff.browser.observed = true;
      handoff.browser.observationId = evidenceId;
    }
    if (handoff.browser && result.errors) handoff.browser.errors = result.errors;
    if (handoff.browser && result.selected) {
      handoff.browser.selected = result.selected;
      if (!handoff.browser.interacted && name === 'browser_read') handoff.browser.observationId = evidenceId;
      if (result.selected.selector === handoff.browser.responseSelector)
        handoff.browser.replyAfter = result.selected.text;
    }
  }
}
