import { expect, it } from 'vitest';
import { newHandoff } from './project-handoff';
import { sourceEvidence } from './source-memory';
import { hasCurrentProjectTest, projectDeliveryFeedback } from './project-delivery';

it('requires a real current test, not inspection, a build, missing exit status or an old check', () => {
  const handoff = newHandoff(undefined, 'Implement feature');
  handoff.generation = 2;
  handoff.lastMutationAt = 100;
  const test = {
    ...sourceEvidence('run_project_process', { executable: 'node', args: ['--test'] }, { exitCode: 0 }),
    at: 101,
    projectRevision: 2,
  };
  expect(hasCurrentProjectTest(handoff, [test])).toBe(true);
  for (const bad of [
    { ...test, projectRevision: 1 },
    { ...test, at: 99 },
    { ...test, result: '{}' },
    { ...test, result: '{"exitCode":1}' },
    { ...test, result: '{"exitCode":0,"timedOut":true}' },
    { ...test, result: '{"exitCode":0,"verificationUnknown":true}' },
    { ...test, input: '{"command":"npm run build"}' },
    { ...test, tool: 'read_project_file' },
    { ...test, input: '{"command":"echo test","purpose":"test"}' },
    { ...test, input: JSON.stringify({ command: 'node -e "console.log(\'npm test\')"' }) },
    { ...test, input: '{"command":"npm test --help"}' },
  ])
    expect(hasCurrentProjectTest(handoff, [bad])).toBe(false);
  expect(projectDeliveryFeedback(handoff, [], true)).toContain('needsTest');
  expect(projectDeliveryFeedback(handoff, [test], true)).toContain('"missingCriteria":true');
  handoff.requirements = [{ text: 'Behavior tested', status: 'passed', verification: 'command', evidenceIds: [test.id] }];
  expect(projectDeliveryFeedback(handoff, [test], true)).toBeUndefined();
});

it('returns missing browser delivery stages and compatibility to Main even when prior criteria passed', () => {
  const handoff = newHandoff(undefined, 'Run model inference in the browser');
  handoff.requiresModelVerification = true; // Established by inspected browser runtime files.
  handoff.requirements = [
    { text: 'Source reviewed', verification: 'inspection', status: 'passed', evidenceIds: ['source'] },
  ];
  const feedback = projectDeliveryFeedback(handoff, [], false);
  expect(feedback).toContain('missingCompatibility');
  expect(feedback).toContain('"missingStages":["page","model","inference"]');
});

it('accepts a custom smoke test with an explicit test purpose and a post-interaction browser observation', () => {
  const handoff = newHandoff(undefined, 'Implement');
  const test = sourceEvidence(
    'run_project_process',
    { executable: 'python', args: ['smoke.py'], purpose: 'test' },
    { exitCode: 0 },
  );
  expect(hasCurrentProjectTest(handoff, [test])).toBe(true);
  const page = sourceEvidence('browser_read', {}, { text: 'Clicked result' });
  handoff.browser = {
    url: 'http://localhost:3000',
    openedAt: 1,
    interacted: true,
    observed: true,
    observationId: page.id,
  };
  expect(hasCurrentProjectTest(handoff, [page])).toBe(true);
  handoff.browser.interacted = false;
  expect(hasCurrentProjectTest(handoff, [page])).toBe(false);
});
