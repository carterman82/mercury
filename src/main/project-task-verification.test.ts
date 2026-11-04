import { expect, it } from 'vitest';
import { newHandoff, recordProjectAction, updateProjectTask } from './project-progress';
import { sourceEvidence } from './source-memory';

function observation(tool: string, id: string, result: unknown) {
  return { ...sourceEvidence(tool, {}, result), id, at: 100, projectRevision: 0 };
}
it.each([{}, { exitCode: 0, verificationUnknown: true }, { exitCode: 0, projectChange: 'unknown' }, { exitCode: null }])('rejects command evidence without a verified successful exit: %j', result => {
  const handoff = newHandoff(undefined, 'Check');
  expect(() => updateProjectTask(handoff, { requirements: [{ text: 'Check passes', status: 'passed', verification: 'command', evidenceIds: ['check'] }], remaining: '' }, [observation('run_project_process', 'check', result)])).toThrow();
});

it('accepts current successful command evidence and rejects stale evidence before other verification checks', () => {
  const handoff = newHandoff(undefined, 'Check build');
  const evidence = observation('run_project_process', 'check', { exitCode: 0 });
  const criterion = { text: 'Build passes', status: 'passed', verification: 'command', evidenceIds: ['check'] };
  updateProjectTask(handoff, { requirements: [criterion], remaining: '' }, [evidence]);
  expect(handoff.requirements[0].status).toBe('passed');
  handoff.generation = 1;
  const before = structuredClone(handoff);
  expect(() => updateProjectTask(handoff, { requirements: [criterion], remaining: '' }, [{ ...evidence, result: '{broken' }])).toThrow(expect.objectContaining({ code: 'VERIFICATION_EVIDENCE_REQUIRED' }));
  expect(handoff).toEqual(before);
});

it.each(['not_run', 'blocked', 'failed', 'passed'])('rejects impossible stage definitions atomically for %s criteria', status => {
  for (const stage of ['page', 'model', 'inference']) {
    for (const verification of ['inspection', 'command']) {
      const handoff = newHandoff(undefined, 'Plan checks');
      const before = structuredClone(handoff);
      expect(() => updateProjectTask(handoff, { requirements: [
        { text: 'Valid first criterion', status: 'not_run', verification: 'inspection', evidenceIds: [] },
        { text: 'Staged check', status, verification, stage, evidenceIds: [] },
      ], remaining: 'Inspect' }, [])).toThrow(expect.objectContaining({ code: 'VERIFICATION_KIND' }));
      expect(handoff).toEqual(before);
    }
  }
});

it.each(['not_run', 'blocked', 'failed', 'passed'])('rejects incomplete model definitions atomically for %s criteria', status => {
  for (const fields of [{}, { selector: '#status' }, { expectedText: 'Model ready' }, { selector: ' ', expectedText: 'Model ready' }, { selector: '#status', expectedText: ' ' }]) {
    const handoff = newHandoff(undefined, 'Plan checks');
    const before = structuredClone(handoff);
    expect(() => updateProjectTask(handoff, { requirements: [{ text: 'Model ready', status, verification: 'browser', stage: 'model', evidenceIds: [], ...fields }], remaining: 'Load' }, [])).toThrow(expect.objectContaining({ code: 'MODEL_NOT_READY' }));
    expect(handoff).toEqual(before);
  }
});

it('accepts complete pending model definitions without requiring loaded-model evidence', () => {
  const handoff = newHandoff(undefined, 'Plan checks');
  updateProjectTask(handoff, { requirements: [{ text: 'Model ready', status: 'not_run', verification: 'browser', stage: 'model', selector: '#status', expectedText: 'Model ready', evidenceIds: [] }], remaining: 'Load' }, []);
  expect(handoff.requirements[0]).toMatchObject({ status: 'not_run', stage: 'model', selector: '#status', expectedText: 'Model ready' });
});

it('accepts a selected model-ready observation and rejects a prior browser observation without changing criteria', () => {
  const handoff = newHandoff(undefined, 'Load model');
  const url = 'http://127.0.0.1:4177';
  const criterion = { text: 'Model ready', status: 'not_run', verification: 'browser', stage: 'model', selector: '#status', expectedText: 'Model ready', evidenceIds: [] as string[] };
  updateProjectTask(handoff, { requirements: [criterion], remaining: 'Load' }, []);
  recordProjectAction(handoff, 'browser_open', {}, { url }, 'open', 100);
  const ready = observation('browser_read', 'ready', { url, selected: { selector: '#status', text: 'Model ready' }, errors: [] });
  recordProjectAction(handoff, 'browser_read', {}, JSON.parse(ready.result), ready.id, ready.at);
  const before = structuredClone(handoff);
  const old = { ...ready, id: 'old' };
  expect(() => updateProjectTask(handoff, { requirements: [{ ...criterion, status: 'passed', evidenceIds: ['old'] }], remaining: '' }, [old, ready])).toThrow(expect.objectContaining({ code: 'BROWSER_OBSERVATION_STALE' }));
  expect(handoff).toEqual(before);
  updateProjectTask(handoff, { requirements: [{ ...criterion, status: 'passed', evidenceIds: ['ready'] }], remaining: '' }, [ready]);
  expect(handoff.browser?.modelReady).toBe(true);
  expect(handoff.requirements[0].status).toBe('passed');
});
