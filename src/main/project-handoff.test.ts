import { expect, it, vi } from 'vitest';
import { newHandoff, recordProjectAction } from './project-progress';

it('preserves durable handoff scope while omitting prior turn observations and blockers', () => {
  const previous = newHandoff(undefined, 'Run a local model in the browser');
  previous.verificationTarget = { kind: 'browser_model', sources: [{ path: 'index.html', hash: 'inspected' }], reason: 'Inspected browser inference runtime' };
  previous.generation = 3;
  previous.snapshots = [{ path: 'app.ts', hash: 'old' }];
  previous.requirements = [{ id: 'criterion', text: 'Works', status: 'passed', verification: 'inspection', evidenceIds: ['evidence'] }];
  previous.browser = { url: 'http://127.0.0.1:4173', openedAt: 1, interacted: false, observed: false };
  previous.lastMutationAt = 2;
  previous.blocker = { tool: 'patch_project_file', target: 'app.ts', code: 'PATCH_NO_MATCH', message: 'No match', nextAction: 'Read', at: 3 };
  previous.failedApproaches = [{ tool: 'patch_project_file', target: 'app.ts', code: 'PATCH_NO_MATCH', input: '{}', message: 'No match', at: 3 }];
  const next = newHandoff(previous, 'Continue');
  expect(next).toMatchObject({ objective: previous.objective, requiresModelVerification: true, generation: 3, snapshots: previous.snapshots, requirements: previous.requirements, remaining: 'Continue' });
  for (const key of ['browser', 'blocker', 'lastMutationAt', 'failedApproaches']) expect(next).not.toHaveProperty(key);
});

it('invalidates passed verification even for a successful no-op write', () => {
  const handoff = newHandoff(undefined, 'Fix the app');
  handoff.requirements = [{ text: 'Works', status: 'passed', verification: 'inspection', evidenceIds: ['old'] }];
  handoff.browser = { url: 'http://127.0.0.1:4173', openedAt: 1, interacted: false, observed: false };
  recordProjectAction(handoff, 'patch_project_file', { path: 'app.ts' }, { path: 'app.ts', previousHash: 'same', hash: 'same' }, 'write', 10);
  expect(handoff).toMatchObject({ generation: 1, lastMutationAt: 10, changedPaths: ['app.ts'], snapshots: [{ path: 'app.ts', hash: 'same' }], requirements: [{ status: 'not_run', evidenceIds: ['old'] }] });
  expect(handoff.browser).toBeUndefined();
});

it('retains successful checks until an uncertain failed command invalidates them', () => {
  const handoff = newHandoff(undefined, 'Check the app');
  handoff.requirements = [{ text: 'Works', status: 'passed', verification: 'command', evidenceIds: ['passed'] }];
  vi.spyOn(Date, 'now').mockReturnValue(20);
  try {
    recordProjectAction(handoff, 'run_project_process', { executable: 'node' }, { exitCode: 0, projectChanged: false }, 'passed', 10);
    expect(handoff.requirements[0].status).toBe('passed');
    recordProjectAction(handoff, 'run_project_process', { executable: 'node' }, { exitCode: 1, verificationUnknown: true }, 'failed', 11);
    expect(handoff.requirements[0].status).toBe('not_run');
    expect(handoff.generation).toBe(1);
    expect(handoff.completedSteps).toEqual([]);
    expect(handoff.checks).toEqual([{ name: 'node', status: 'passed', at: 20, evidenceId: 'passed' }, { name: 'node', status: 'failed', at: 20, evidenceId: 'failed' }]);
  } finally { vi.restoreAllMocks(); }
});
