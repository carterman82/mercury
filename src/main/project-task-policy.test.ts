import { expect, it } from 'vitest';
import { beginProjectRequest, recordProjectDiagnosis, requireDiagnosisForEdit, backendScopeReason, enforceCommandTaskScope } from './project-task-policy';
import { newHandoff } from './project-handoff';
import { sourceEvidence } from './source-memory';

it.each(['Do not implement; explain why', 'Read main.py and tell me what it does', 'Show the current status', 'Analyze without changing code'])('keeps inspection read-only: %s', text => {
  const h = newHandoff(undefined, text); h.taskPolicy = beginProjectRequest(undefined, text, 'request');
  expect(h.taskPolicy.intent).toBe('answer');
  expect(() => requireDiagnosisForEdit(h, 'main.py')).toThrow('does not authorize');
});
it('recognizes an authorized fix and preserves the request on resume', () => {
  const policy = beginProjectRequest(undefined, 'Explain why it fails and fix it', 'one');
  expect(policy.intent).toBe('debug');
  expect(beginProjectRequest(policy, 'Continue', 'two')).toMatchObject({ intent: 'debug', request: policy.request, requestId: 'two' });
});
it('blocks debugging edits until actual current execution evidence is cited', () => {
  const h = newHandoff(undefined, 'Fix empty response'); h.taskPolicy = beginProjectRequest(undefined, 'Fix empty response', 'one');
  expect(() => requireDiagnosisForEdit(h, 'main.py')).toThrow('actual diagnostic');
  const read = sourceEvidence('read_project_file', {}, { content: 'url = endpoint' });
  const diagnosis = { symptom: 'Empty response', hypothesis: 'Response may contain only reasoning', testToConfirm: 'POST the existing endpoint', proposedChange: 'Handle observed response fields', affectedPaths: ['main.py'], evidenceIds: [read.id] };
  expect(recordProjectDiagnosis(h, diagnosis, [read]).executionConfirmed).toBe(false);
  const denied = sourceEvidence('run_project_command', {}, { error: 'denied' });
  expect(recordProjectDiagnosis(h, { ...diagnosis, evidenceIds: [denied.id] }, [denied]).executionConfirmed).toBe(false);
  const probe = sourceEvidence('probe_project_endpoint', {}, { ran: true, status: 400, output: 'unknown model' });
  expect(recordProjectDiagnosis(h, { ...diagnosis, evidenceIds: [probe.id] }, [probe]).executionConfirmed).toBe(true);
  expect(() => requireDiagnosisForEdit(h, 'main.py')).not.toThrow();
  expect(() => requireDiagnosisForEdit(h, 'unrelated.py')).toThrow('outside');
  h.generation = 1;
  expect(() => recordProjectDiagnosis(h, { ...diagnosis, evidenceIds: [probe.id] }, [probe])).toThrow('current evidence');
});
it('keeps setup narrow and does not infer runtime/backend installation consent', () => {
  const policy = beginProjectRequest(undefined, 'Install pytest and requests using existing Python', 'one');
  expect(policy.intent).toBe('setup');
  expect(() => enforceCommandTaskScope(policy, 'python main.py')).toThrow('bounded');
  expect(() => enforceCommandTaskScope(policy, 'python -B -m pytest', 'test')).not.toThrow(); // Tool layer confines setup test writes.
  expect(() => enforceCommandTaskScope(undefined, 'uv python install 3.12')).toThrow('does not authorize');
  expect(() => enforceCommandTaskScope(beginProjectRequest(undefined, 'Install Python 3.12', 'two'), 'uv python install 3.12')).not.toThrow();
  const debug = beginProjectRequest(undefined, 'Fix the existing server', 'three');
  expect(backendScopeReason(debug, '', 'from gpt4all import GPT4All')).toContain('alternative');
  expect(backendScopeReason(debug, 'import requests', 'import requests\n# fixed')).toBeUndefined();
  expect(beginProjectRequest(undefined, 'Do not implement a fallback', 'four').backendChangeRequested).toBe(false);
});
