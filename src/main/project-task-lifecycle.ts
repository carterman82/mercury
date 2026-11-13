import type { ChatThread } from '../shared/types';
import { beginProjectRequest } from './project-task-policy';

const resumeRequest = /^\s*(?:sorry[,\s]*)?(?:resume|continue|carry on|keep going)[.!\s]*$/i;

/** Separate this turn's permissions from the execution task retained for Resume. */
export function reconcileProjectTurn(chat: ChatThread, request: string, requestId: string, forceExecution = false): void {
  const handoff = chat.projectHandoff!;
  let active = handoff.executionPolicy ?? (handoff.taskPolicy?.intent !== 'answer' ? handoff.taskPolicy : undefined);
  if (!active) {
    const prior = [...chat.messages].reverse().find(item => item.role === 'user' && item.content !== request && !resumeRequest.test(item.content) && beginProjectRequest(undefined, item.content, item.id).intent !== 'answer');
    if (prior) active = beginProjectRequest(undefined, prior.content, prior.id);
  }
  const resume = resumeRequest.test(request);
  const policy = resume && active ? { ...structuredClone(active), requestId } : beginProjectRequest(active, request, requestId);
  if (forceExecution && policy.intent === 'answer') policy.intent = 'implementation';
  if (active) handoff.executionPolicy = active;
  handoff.taskPolicy = policy;
  if (policy.intent === 'answer') return;
  const objective = policy.request.slice(0, 4000);
  if (handoff.objective !== objective) {
    const completed = handoff.requirements.filter(item => ['completed', 'passed'].includes(item.status));
    handoff.retiredRequirements = [...(handoff.retiredRequirements ?? []), ...completed.map(requirement => ({ requirement, reason: `Completed before current request: ${handoff.objective ?? 'previous task'}` }))];
    handoff.requirements = handoff.requirements.filter(item => !['completed', 'passed'].includes(item.status));
    handoff.objective = objective;
    handoff.remaining = objective;
    handoff.needsCurrentRequirements = true;
    if (chat.workPlan && chat.workPlan.objective !== objective) {
      handoff.retiredWorkPlans = [...(handoff.retiredWorkPlans ?? []), structuredClone(chat.workPlan)];
      chat.workPlan = { ...chat.workPlan, objective, steps: [], revision: chat.workPlan.revision + 1, updatedAt: Date.now() };
    }
  }
  handoff.executionPolicy = policy;
}

/** Preparation has rehashed retained reads/snapshots and advanced generation on changes. */
export function validateResumedDiagnosis(chat: ChatThread): void {
  const handoff = chat.projectHandoff;
  const diagnosis = handoff?.taskPolicy?.diagnosis;
  if (diagnosis && diagnosis.revision !== (handoff?.generation ?? 0)) diagnosis.executionConfirmed = false;
  if (handoff?.taskPolicy?.intent !== 'answer' && handoff?.taskPolicy) handoff.executionPolicy = handoff.taskPolicy;
}
