import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProjectHandoff, SourceEvidence } from '../shared/types';
import { ToolFailure } from './tool-outcome';
import { compatibilitySchema, validateCompatibility } from './project-task-compatibility';
import { requirementSchema, validateRequirementDefinition, verifyRequirement } from './project-task-verification';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
    taskPolicy: handoff.taskPolicy, verificationTarget: handoff.verificationTarget, retiredRequirements: handoff.retiredRequirements,
    remaining: handoff.remaining, generation: handoff.generation, blocker: handoff.blocker,
    browser: handoff.browser, nextAction: 'Send only new criteria/status updates. A compatibility-only repair uses requirements:[]; unchanged criteria are retained automatically.' };
}

export const projectTaskInstructions = `\nPROJECT DELIVERY CONTRACT\nBefore edits, commands or implementation assignments, call update_project_task to record concrete acceptance criteria for implementation requests. Preserve explicit user requirements across follow-ups; a resume message does not replace them. For browser model work include compatibility:{runtime,version,modelFormat,modelId,maxBytes,evidenceIds} from inspected runtime sources/docs, plus three browser criteria stage:page, stage:model with selector/expectedText for the ready indicator, and stage:inference. Transformers.js expects modelFormat:onnx; WebLLM expects modelFormat:mlc (JSON manifests, binary weight shards and WASM runtime). GGUF needs a verified GGUF-capable browser runtime. Use exact evidenceId values from successful tool results, never invented IDs. Unverified requirements use status:not_run and evidenceIds:[]. A fallback/demo/canned reply does not satisfy requested real model inference. Prefer incremental patches to large rewrites. Record requirements as passed only with current successful evidence. For website functional checks: reload after edits, inspect script errors, mark the model-ready criterion passed, submit a question with browser_fill responseSelector, then browser_read with that response selector to observe a NEW reply/result. Opening a page alone is not testing it. If blocked, state changed versus unverified behavior. Do not announce completion while requirements remain blocked, failed or not run.\n`;

export function updateProjectTask(handoff: ProjectHandoff, raw: unknown, evidence: SourceEvidence[]) {
  const value = taskSchema.parse(raw);
  const versionCorrected = validateCompatibility(handoff, value, evidence);
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

