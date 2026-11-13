import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectHandoff, SourceEvidence } from '../shared/types';
import { ToolFailure } from './tool-outcome';
import { compatibilitySchema, validateCompatibility } from './project-task-compatibility';
import { requirementSchema, validateRequirementDefinition, verifyRequirement } from './project-task-verification';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function initializeContractCall(handoff: ProjectHandoff | undefined) {
  const text = handoff?.objective?.trim() || 'Implement the requested project change';
  return { name: 'update_project_task', arguments: {
    requirements: [{ text, status: 'not_run', verification: 'inspection', evidenceIds: [] }],
    remaining: handoff?.remaining || text,
  } };
}

const completionSchema = z.object({
  requirementIds: z.array(z.string().min(1).max(100)).min(1).max(40).describe('IDs from read_project_task or update_project_task. Only listed requirements are checked off.'),
  note: z.string().trim().min(1).max(4000).describe('What was completed and any checks that could not be run. Completion is your assessment, not a verified test pass.'),
}).strict();
const { $schema: _completionSchema, ...completionParameters } = z.toJSONSchema(completionSchema);
export const projectTaskCompleteTool = {
  type: 'function', function: {
    name: 'complete_project_requirements',
    description: 'Check off implemented requirements by ID in one call. No evidence IDs, test run, browser session or repeated definitions needed. Supply a short note describing the work and verification limitations. Marks items completed by AI, not verified. Use only when the requested work is implemented; leave unfinished work blocked/failed/not_run. Later edits reopen completed items.',
    parameters: completionParameters,
  },
};

export function completeProjectRequirements(handoff: ProjectHandoff, raw: unknown) {
  const value = completionSchema.parse(raw);
  const ids = new Set(value.requirementIds);
  if ([...ids].some(id => !handoff.requirements.some(item => item.id === id)))
    throw new ToolFailure('UNKNOWN_REQUIREMENT', 'Use only the exact saved requirement IDs. No requirements were changed.', {
      unknownRequirementIds: [...ids].filter(id => !handoff.requirements.some(item => item.id === id)),
      availableRequirements: handoff.requirements.map(({ id, text, status }) => ({ id, text, status })),
      nextAction: handoff.requirements.length ? 'Select the implemented requirements from availableRequirements; do not invent IDs.' : 'Initialize pending criteria with update_project_task before attempting completion.',
      recoveryCall: handoff.requirements.length ? { name: 'read_project_task', arguments: {} } : initializeContractCall(handoff),
    });
  handoff.requirements = handoff.requirements.map(item => ids.has(item.id ?? '') && item.status !== 'passed'
    ? { ...item, status: 'completed', completionNote: value.note, evidenceIds: [] } : item);
  if (handoff.requirements.every(item => item.status === 'completed' || item.status === 'passed')) handoff.remaining = '';
  handoff.updatedAt = Date.now();
  return readProjectTask(handoff);
}

const taskSchema = z
  .object({
    requirements: z.array(requirementSchema).max(20).describe('Only new criteria or status updates. Use [] for a compatibility-only or remaining-work update; all existing criteria are retained.'),
    remaining: z.string().max(4000),
    compatibility: compatibilitySchema,
    compatibilityCorrection: z.string().trim().min(1).max(1000).describe('Reason for a documented runtime version correction. Requires a new successful source observation; runtime, model, layout and byte limit stay fixed. Invalidates prior verification.').optional(),
  })
  .strict();
const { $schema: _schema, ...parameters } = z.toJSONSchema(taskSchema);
export const projectTaskTool = {
  type: 'function',
  function: {
    name: 'update_project_task',
    description:
      'Persist concrete acceptance requirements and verification status. Initialize NEW criteria with status:not_run and evidenceIds:[]; returned IDs are authoritative. New completed criteria without a completion note are saved as pending with an explicit warning. Send only NEW criteria or status updates; omitted criteria are retained. To check off implemented work easily, use complete_project_requirements with IDs and a note; no evidence is required for AI completion. Only status:passed claims verified success and requires current successful evidence IDs. Preserve original requirements. Set blocked/failed/not_run for unfinished work.',
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
    taskPolicy: handoff.taskPolicy, verificationTarget: handoff.verificationTarget, retiredRequirements: handoff.retiredRequirements,
    ...(handoff.needsCurrentRequirements ? { needsCurrentRequirements: true } : {}),
    remaining: handoff.remaining, generation: handoff.generation, blocker: handoff.blocker,
    reads: handoff.reads.slice(-50), snapshots: handoff.snapshots?.slice(-100),
    browser: handoff.browser, ...(!handoff.requirements.length ? {
      nextAction: 'First initialize pending criteria with update_project_task, status:not_run, evidenceIds:[]. Use its returned IDs for later completion. No requirements have been completed.',
      recoveryCall: initializeContractCall(handoff),
    } : { nextAction: 'For implemented requirements, call complete_project_requirements with exact saved requirementIds and a note; no direct verification is required. For verified success or unfinished work, use update_project_task. Omitted criteria are retained.' }) };
}

export const projectTaskInstructions = `\nPROJECT DELIVERY CONTRACT\nBefore edits, commands or implementation assignments, call update_project_task to record concrete acceptance criteria for implementation requests. Preserve explicit user requirements across follow-ups; a resume message does not replace them. For browser model work include compatibility:{runtime,version,modelFormat,modelId,maxBytes,evidenceIds} from inspected runtime sources/docs, plus three browser criteria stage:page, stage:model with selector/expectedText for the ready indicator, and stage:inference. Transformers.js expects modelFormat:onnx; WebLLM expects modelFormat:mlc (JSON manifests, binary weight shards and WASM runtime). GGUF needs a verified GGUF-capable browser runtime. Use exact evidenceId values from successful tool results, never invented IDs. Unverified requirements use status:not_run and evidenceIds:[]. A fallback/demo/canned reply does not satisfy requested real model inference. Prefer incremental patches to large rewrites. Record requirements as passed only with current successful evidence. For website functional checks: reload after edits, inspect script errors, mark the model-ready criterion passed, submit a question with browser_fill responseSelector, then browser_read with that response selector to observe a NEW reply/result. Opening a page alone is not testing it. If blocked, state changed versus unverified behavior. Check off implemented requirements with complete_project_requirements({requirementIds:[...],note:"Implemented work; verification limitations"}). This needs no evidence IDs or direct verification and permits delivery without a test run. Completion is an AI assessment, not a passed test. Keep unfinished requirements blocked, failed or not_run. Explain any earlier tool failures that remain relevant. Use update_project_task status:passed only for actual verified success.\n`;

export function updateProjectTask(handoff: ProjectHandoff, raw: unknown, evidence: SourceEvidence[]) {
  const value = taskSchema.parse(raw);
  const versionCorrected = validateCompatibility(handoff, value, evidence);
  const initializationWarnings: { requirementId: string; requestedStatus: string; savedStatus: string; reason: string }[] = [];
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
    // A malformed completion claim must not prevent valid new criteria from
    // establishing a contract. Save the definition, never the unsupported claim.
    if (!prior && requirement.status === 'completed' && !requirement.completionNote) {
      requirement.status = 'not_run';
      requirement.evidenceIds = [];
      initializationWarnings.push({ requirementId: requirement.id, requestedStatus: 'completed', savedStatus: 'not_run', reason: 'New criterion has no completion note; saved as pending.' });
    }
    validateRequirementDefinition(requirement);
    if (requirement.status !== 'passed') continue;
    verifyRequirement(handoff, requirement, evidence);
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
  if (value.requirements.some(item => !['completed', 'passed'].includes(item.status))) handoff.needsCurrentRequirements = false;
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
  return { ...handoff, implementationReady, verificationReady: implementationReady && !missingStages.length, missingStages,
    ...(initializationWarnings.length ? { initializationWarnings, nextAction: 'The new criteria were saved as pending. Implement the work first, then call complete_project_requirements with the exact returned IDs and a note describing completed work and verification limitations.' } : {}), ...(!handoff.requirements.length ? {
    nextAction: 'Before implementation, add concrete acceptance criteria with update_project_task. A metadata-only update does not create a delivery contract.',
  } : !implementationReady ? {
    nextAction: 'Before implementation, call update_project_task again. Supply compatibility from successful source evidence and ADD separate requirements with stage:"page", stage:"model", stage:"inference", verification:"browser", status:"not_run", evidenceIds:[]. Model stage needs selector and expectedText for the ready indicator. Preserve existing requirements unchanged.',
  } : missingStages.length ? { nextAction: 'Implementation may proceed with the documented model compatibility. Before final delivery add separate browser criteria with stage:"page", stage:"model", and stage:"inference" and verify them; existing criteria must be preserved.' } : {}) };
}
export function requireProjectContract(handoff: ProjectHandoff | undefined, delivery = false) {
  if (handoff?.needsCurrentRequirements) throw new ToolFailure('NEED_TASK_CONTRACT', 'Initialize pending acceptance criteria for the current request with update_project_task. Previous completed criteria are historical; unfinished constraints remain active.', { recoveryCall: initializeContractCall(handoff) });
  if (!handoff?.requirements.length)
    throw new ToolFailure(
      'NEED_TASK_CONTRACT',
      'Record concrete acceptance criteria with update_project_task before changing the project or running commands. No action was executed.',
      { nextAction: 'Initialize pending criteria with status:not_run and evidenceIds:[]. Use the returned IDs for completion after implementation; do not mark new work completed during setup.', recoveryCall: initializeContractCall(handoff) },
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

