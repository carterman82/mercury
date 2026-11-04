import { z } from 'zod';
import type { ProjectHandoff, ProjectRequirement, SourceEvidence } from '../shared/types';
import { ToolFailure, toolFailed } from './tool-outcome';

export const requirementSchema = z
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

/** Validate immutable criterion fields before they can enter the saved contract.
 * Runtime readiness and evidence remain separate, passed-only checks. */
export function validateRequirementDefinition(requirement: ProjectRequirement): void {
  if (requirement.stage && requirement.verification !== 'browser')
    throw new ToolFailure('VERIFICATION_KIND', 'Page/model/inference stages require browser verification.');
  if (requirement.stage === 'model' && (!requirement.selector?.trim() || !requirement.expectedText?.trim()))
    throw new ToolFailure('MODEL_NOT_READY', 'Model-stage requirements need selector and expectedText for the loaded-model indicator before they can be saved.');
}

export function verifyRequirement(handoff: ProjectHandoff, requirement: ProjectRequirement, evidence: SourceEvidence[]): void {
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
    !observations.some((item) => {
      if (!['run_project_command', 'run_project_process'].includes(item!.tool)) return false;
      const result = JSON.parse(item!.result);
      return result.exitCode === 0 && !result.verificationUnknown && result.projectChange !== 'unknown';
    })
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
