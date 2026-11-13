import { expect, it } from 'vitest';
import type { ChatThread } from '../shared/types';
import { newHandoff } from './project-handoff';
import { beginProjectRequest } from './project-task-policy';
import { reconcileProjectTurn, validateResumedDiagnosis } from './project-task-lifecycle';

function fixture(): ChatThread {
  const handoff = newHandoff(undefined, 'Fix old behavior');
  handoff.taskPolicy = beginProjectRequest(undefined, 'Fix old behavior', 'old');
  handoff.requirements = [{ id: 'old', text: 'Old criterion', status: 'completed', evidenceIds: [] }, { id: 'keep', text: 'Unfinished constraint', status: 'not_run', evidenceIds: [] }];
  handoff.taskPolicy.diagnosis = { symptom: 'old', hypothesis: 'old', testToConfirm: 'test', proposedChange: 'fix', affectedPaths: ['main.py'], evidenceIds: ['observed'], at: 1, revision: 0, executionConfirmed: true };
  return { id: 'chat', title: 'Test', projectId: 'p', profile: { provider: 'ollama', model: 'local', contextLimit: 32000 }, projectHandoff: handoff, messages: [], status: 'idle', updatedAt: 1 };
}
it('archives completed criteria for a new request while retaining unfinished constraints', () => {
  const chat = fixture();
  reconcileProjectTurn(chat, 'Implement structured stories', 'new');
  expect(chat.projectHandoff!.objective).toBe('Implement structured stories');
  expect(chat.projectHandoff!.requirements.map(item => item.id)).toEqual(['keep']);
  expect(chat.projectHandoff!.retiredRequirements?.[0].requirement.id).toBe('old');
  expect(chat.projectHandoff!.taskPolicy?.diagnosis).toBeUndefined();
});
it('answers read-only questions without losing the execution task, then resumes a validated diagnosis', () => {
  const chat = fixture();
  reconcileProjectTurn(chat, 'Explain the current status without changing files', 'question');
  expect(chat.projectHandoff!.taskPolicy?.intent).toBe('answer');
  expect(chat.projectHandoff!.objective).toBe('Fix old behavior');
  reconcileProjectTurn(chat, 'Resume', 'resume');
  validateResumedDiagnosis(chat);
  expect(chat.projectHandoff!.taskPolicy?.request).toBe('Fix old behavior');
  expect(chat.projectHandoff!.taskPolicy?.diagnosis?.executionConfirmed).toBe(true);
  chat.projectHandoff!.generation = 1;
  validateResumedDiagnosis(chat);
  expect(chat.projectHandoff!.taskPolicy?.diagnosis?.executionConfirmed).toBe(false);
});
it('reconciles legacy completed criteria on Resume against the newer execution request', () => {
  const chat = fixture();
  chat.projectHandoff!.requirements = chat.projectHandoff!.requirements.slice(0, 1);
  chat.projectHandoff!.taskPolicy = beginProjectRequest(undefined, 'Implement new stories', 'previous');
  reconcileProjectTurn(chat, 'Resume', 'new');
  expect(chat.projectHandoff!.objective).toBe('Implement new stories');
  expect(chat.projectHandoff!.requirements).toEqual([]);
  expect(chat.projectHandoff!.retiredRequirements).toHaveLength(1);
});
