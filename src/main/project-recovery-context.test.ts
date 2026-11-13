import { expect, it } from 'vitest';
import type { ChatThread } from '../shared/types';
import { newHandoff } from './project-handoff';
import { beginProjectRequest } from './project-task-policy';
import { projectRecoveryCheckpoint } from './project-recovery-context';

it('keeps large recovery checkpoints bounded with explicit retrieval and omission metadata', () => {
  const task = newHandoff(undefined, 'Current request '.repeat(300));
  task.taskPolicy = beginProjectRequest(undefined, task.objective!, 'request');
  task.requirements = Array.from({ length: 40 }, (_, i) => ({ id: `${i}`.padEnd(100, 'x'), text: 'A required behavior '.repeat(100), status: 'not_run' as const, evidenceIds: [] }));
  task.taskPolicy.diagnosis = { symptom: 's', hypothesis: 'h', testToConfirm: 'test', proposedChange: 'fix', affectedPaths: Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(500, 'a')), evidenceIds: ['actual'], at: 1, revision: 0, executionConfirmed: true };
  const chat: ChatThread = { id: 'c', title: 'Test', profile: { provider: 'ollama', model: 'm', contextLimit: 32000 }, projectHandoff: task, messages: [], status: 'idle', updatedAt: 1 };
  const output = projectRecoveryCheckpoint(chat);
  expect(output.length).toBeLessThanOrEqual(6000);
  const checkpoint = JSON.parse(output);
  expect(checkpoint.diagnosis.accepted).toBe(true);
  expect(checkpoint.diagnosis.message).toContain('Diagnosis accepted');
  expect(checkpoint.omittedRequirements).toBe(32);
  expect(checkpoint.diagnosis.omittedPaths).toBe(26);
  expect(checkpoint.retrieval).toContain('read_project_task');
  expect(task.requirements).toHaveLength(40);
});
