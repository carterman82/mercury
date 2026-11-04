import { expect, it, vi } from 'vitest';
import {
  ProjectProgress,
  ProjectStalledError,
  newHandoff,
  recordProjectAction,
  updateProjectTask,
  requireProjectContract,
  projectActionIdentity,
  readProjectTask,
  verifiedPreviewRecovery,
} from './project-progress';
import { toolFailed } from './tool-outcome';
import { sourceEvidence } from './source-memory';

it('replays the failed Windows command loop: recover once, then stop', () => {
  const progress = new ProjectProgress();
  const call = () =>
    progress.observe(
      'run_project_command',
      { command: 'node -e broken-selector' },
      { exitCode: 1, output: 'SyntaxError' },
    );
  expect(call()).toBeUndefined();
  expect(call()).toBeUndefined();
  expect(call()).toContain('MERCURY RECOVERY');
  expect(call()).toBeUndefined();
  expect(call()).toBeUndefined();
  expect(call).toThrow(ProjectStalledError);
  expect(progress.recoveries).toBe(1);
});

it('groups varied patch failures across interleaved reads by actual source revision', () => {
  const progress = new ProjectProgress();
  for (let i = 0; i < 3; i++) {
    progress.attempt();
    const recovery = progress.observe(
      'patch_project_file',
      { path: 'app.js', revision: `different-${i}`, oldText: `variant ${i}` },
      { error: 'No match', code: 'PATCH_NO_MATCH', sourceRevision: 'same' },
    );
    if (i === 2) expect(recovery).toContain('MERCURY RECOVERY');
    else progress.observe('read_project_file', { path: `file${i}` }, { hash: 'a', content: String(i) });
  }
  expect(progress.recoveries).toBe(1);
});
it('keeps unrelated failing commands separate while grouping quoting and whitespace repairs', () => {
  const independent = new ProjectProgress();
  for (const command of ['npm run lint', 'npm test', 'npm run build']) {
    expect(
      independent.observe('run_project_command', { command }, { exitCode: 1, output: 'Check failed' }),
    ).toBeUndefined();
  }
  expect(independent.recoveries).toBe(0);
  const repeated = new ProjectProgress();
  const commands = ['node "check.js"', 'node   check.js', "node 'check.js'"];
  for (let index = 0; index < commands.length; index++) {
    const result = repeated.observe(
      'run_project_command',
      { command: commands[index] },
      { exitCode: 1, output: 'Check failed' },
    );
    if (index === 2) expect(result).toContain('MERCURY RECOVERY');
    else expect(result).toBeUndefined();
  }
});
it('groups broken script repair attempts but separates independent structured checks', () => {
  const broken = new ProjectProgress();
  for (let index = 0; index < 3; index++) {
    const result = broken.observe(
      'run_project_command',
      { command: `node -e "broken${index}"` },
      { exitCode: 1, output: 'SyntaxError' },
    );
    if (index === 2) expect(result).toContain('MERCURY RECOVERY');
  }
  const checks = new ProjectProgress();
  for (const stdin of ['checkLint()', 'checkTypes()', 'checkBuild()']) {
    expect(
      checks.observe('run_project_process', { executable: 'node', args: ['-'], stdin }, { exitCode: 1 }),
    ).toBeUndefined();
  }
});
it('keeps recovery active after an unrelated successful command and resolves the actual check', () => {
  const progress = new ProjectProgress();
  for (let index = 0; index < 3; index++)
    progress.observe('run_project_command', { command: 'npm run build' }, { exitCode: 1 });
  for (let index = 0; index < 7; index++) {
    progress.attempt();
    progress.observe('run_project_command', { command: 'echo healthy' }, { exitCode: 0 });
  }
  progress.attempt();
  expect(() => progress.observe('run_project_command', { command: 'echo healthy' }, { exitCode: 0 })).toThrow('eight');
  const resolved = new ProjectProgress();
  for (let index = 0; index < 3; index++)
    resolved.observe('run_project_command', { command: 'npm run build' }, { exitCode: 1 });
  resolved.attempt();
  resolved.observe('run_project_process', { executable: 'npm', args: ['run', 'build'] }, { exitCode: 0 });
  for (let index = 0; index < 12; index++) expect(() => resolved.attempt()).not.toThrow();
  expect(projectActionIdentity('run_project_command', { command: 'npm run "build"' })).toBe(
    projectActionIdentity('run_project_process', { executable: 'npm', args: ['run', 'build'] }),
  );
});
it('resolves patch recovery only after a verified successful mutation of its own source file', () => {
  for (const result of [
    { exitCode: 0, projectChanged: true, changedPaths: ['helper.cjs'] },
    { exitCode: 0, projectChanged: false, changedPaths: ['app.js'] },
    { exitCode: 1, projectChanged: true, changedPaths: ['app.js'] },
  ]) {
    const pending = new ProjectProgress({ maxAttempts: 1 });
    pending.recover('patch mismatch', 'patch_project_file', 'app.js');
    pending.attempt();
    expect(() => pending.observe('run_project_process', { executable: 'node', args: ['fix.cjs'] }, result)).toThrow('eight');
  }
  const resolved = new ProjectProgress({ maxAttempts: 1 });
  resolved.recover('patch mismatch', 'patch_project_file', 'app.js', false, { action: 'old patch identity', failureCode: 'PATCH_NO_MATCH' });
  resolved.attempt();
  resolved.observe('run_project_process', { executable: 'node', args: ['fix.cjs'] }, { exitCode: 0, projectChanged: true, changedPaths: ['app.js'] });
  for (let index = 0; index < 12; index++) expect(() => resolved.attempt()).not.toThrow();
});

it('recognizes a verified managed preview after repairing its launch command', () => {
  const blocker = { name: 'start_project_server', target: '.' };
  const ready = { id: 'managed-preview', running: true, url: 'http://127.0.0.1:4176' };
  expect(verifiedPreviewRecovery(blocker, 'start_project_server', '.', ready)).toBe(true);
  for (const result of [{ ...ready, running: false }, { ...ready, url: 'https://example.com' }, { ...ready, error: 'failed' }])
    expect(verifiedPreviewRecovery(blocker, 'start_project_server', '.', result)).toBe(false);
  expect(verifiedPreviewRecovery(blocker, 'start_project_server', 'other-project', ready)).toBe(false);
  const progress = new ProjectProgress({ maxAttempts: 1 });
  progress.recover('bad preview flags', 'start_project_server', '.', false, { action: 'failed command', failureCode: 'SERVER_START_FAILED' });
  progress.attempt();
  progress.observe('start_project_server', { command: 'node static-server.cjs' }, ready);
  for (let index = 0; index < 12; index++) expect(() => progress.attempt()).not.toThrow();
});

it('detects cycles across eight unchanged files but permits fresh ranges', () => {
  const progress = new ProjectProgress();
  let recovered = false;
  for (let i = 0; i < 16; i++) {
    const value = progress.observe(
      'read_project_file',
      { path: `file${i % 8}` },
      { hash: 'a', startLine: 1, endLine: 200, content: String(i % 8) },
    );
    if (value) {
      recovered = true;
      break;
    }
  }
  expect(recovered).toBe(true);
});
it('bounds recovery provider time while excluding queue waits and tools', async () => {
  vi.useFakeTimers();
  try {
    const stopped = vi.fn();
    const progress = new ProjectProgress({ onStall: stopped });
    progress.recover('loop');
    progress.providerState('queued');
    await vi.advanceTimersByTimeAsync(300000);
    expect(stopped).not.toHaveBeenCalled();
    progress.providerState('running');
    await vi.advanceTimersByTimeAsync(60000);
    progress.providerState('idle');
    await vi.advanceTimersByTimeAsync(300000);
    expect(stopped).not.toHaveBeenCalled();
    progress.providerState('running');
    await vi.advanceTimersByTimeAsync(60001);
    expect(stopped).toHaveBeenCalledOnce();
    expect(() => progress.attempt()).toThrow('two minutes');
    progress.dispose();
  } finally {
    vi.useRealTimers();
  }
});
it('limits unresolved recovery attempts and shares its allowance with completion repair', () => {
  const progress = new ProjectProgress();
  progress.recover('first blocker', 'patch_project_file', 'app.js');
  for (let i = 0; i < 8; i++) progress.attempt();
  expect(() => progress.attempt()).toThrow('eight');
  const another = new ProjectProgress();
  another.recover('loop');
  expect(() => another.recover('completion')).toThrow('after one recovery');
});
it('requires contracts before writes and keeps browser model criteria from being downgraded', () => {
  const handoff = newHandoff(undefined, 'Run a local model in the browser');
  handoff.requiresModelVerification = true; // Established by inspect_project_target, not request wording.
  expect(() => requireProjectContract(handoff)).toThrow('acceptance criteria');
  const registration = updateProjectTask(
    handoff,
    {
      requirements: [
        { text: 'Inference works', stage: 'inference', status: 'not_run', verification: 'browser', evidenceIds: [] },
      ],
      remaining: 'Load model',
    },
    [],
  );
  expect(registration.implementationReady).toBe(false);
  expect(registration.missingStages).toEqual(['page','model']);
  expect(registration.nextAction).toContain('stage:"model"');
  expect(() => requireProjectContract(handoff)).toThrow('compatibility');
  expect(() =>
    updateProjectTask(
      handoff,
      {
        requirements: [
          {
            text: 'Inference works',
            stage: 'inference',
            status: 'not_run',
            verification: 'inspection',
            evidenceIds: [],
          },
        ],
        remaining: '',
      },
      [],
    ),
  ).toThrow('cannot be weakened');
});

it('allows implementation with documented compatibility but requires all browser stages at delivery', () => {
  const handoff=newHandoff(undefined,'Run a local model in the browser');
  handoff.requiresModelVerification=true;
  handoff.requirements=[{text:'Browser inference works',verification:'browser',status:'not_run',evidenceIds:[]}];
  handoff.compatibility={runtime:'Transformers.js',version:'3.6.1',modelFormat:'onnx',modelId:'qwen',maxBytes:500000000,evidenceIds:['observed']};
  expect(()=>requireProjectContract(handoff)).not.toThrow();
  expect(()=>requireProjectContract(handoff,true)).toThrow('explicit stage fields');
});
it('recovers on the third unchanged read but permits new ranges, revisions and post-edit reads', () => {
  const progress = new ProjectProgress();
  const read = (hash = 'a', startLine = 1) =>
    progress.observe(
      'read_project_file',
      { path: 'app.js' },
      { hash, startLine, endLine: startLine + 199, content: 'code' },
    );
  read();
  read();
  read('b');
  read('a', 201);
  expect(read()).toContain('MERCURY RECOVERY');
  read();
  read();
  progress.observe('patch_project_file', { path: 'app.js' }, { hash: 'b' });
  expect(read()).toBeUndefined();
});
it.each([{ exitCode: 1 }, { exitCode: null }, { timedOut: true }, { error: 'denied' }, { isError: true }])(
  'classifies failed results consistently: %j',
  (value) => {
    expect(toolFailed(value)).toBe(true);
  },
);
it('does not treat useful research or successful zero-exit checks as loops', () => {
  const progress = new ProjectProgress();
  for (let i = 0; i < 50; i++)
    expect(
      progress.observe('read_project_file', { path: `file-${i}` }, { hash: 'same', content: 'same' }),
    ).toBeUndefined();
  expect(toolFailed({ exitCode: 0, timedOut: false })).toBe(false);
});
it('does not count old failures outside the bounded call window', () => {
  const progress = new ProjectProgress();
  progress.observe('run_project_command', { command: 'fail' }, { exitCode: 1 });
  for (let i = 0; i < 8; i++) progress.observe('read_project_file', { path: String(i) }, { hash: String(i) });
  expect(progress.observe('run_project_command', { command: 'fail' }, { exitCode: 1 })).toBeUndefined();
});
it('preserves requirements, invalidates browser checks after edits and rejects fake verification', () => {
  const handoff = newHandoff(undefined, 'Use real browser inference');
  const evidence = sourceEvidence('browser_read', {}, { content: 'fallback demo' });
  const requirement = {
    text: 'Real inference works',
    status: 'passed',
    verification: 'browser',
    evidenceIds: [evidence.id],
  };
  expect(() => updateProjectTask(handoff, { requirements: [requirement], remaining: '' }, [evidence])).toThrow(
    'Browser verification',
  );
  recordProjectAction(handoff, 'browser_open', {}, { url: 'http://127.0.0.1:4177' });
  recordProjectAction(handoff, 'browser_fill', {}, {});
  recordProjectAction(handoff, 'browser_read', {}, { errors: ['POSES is not defined'] });
  expect(() => updateProjectTask(handoff, { requirements: [requirement], remaining: '' }, [evidence])).toThrow(
    'script errors',
  );
  recordProjectAction(handoff, 'patch_project_file', { path: 'index.html' }, { path: 'index.html' });
  expect(handoff.browser).toBeUndefined();
  updateProjectTask(
    handoff,
    { requirements: [{ ...requirement, status: 'blocked' }], remaining: 'Need actual model' },
    [evidence],
  );
  expect(handoff.objective).toBe('Use real browser inference');
  expect(handoff.requirements.at(-1)?.status).toBe('blocked');
});

it('accepts successful command evidence without invalidating previous checks', () => {
  const handoff = newHandoff(undefined, 'Run tests');
  const evidence = sourceEvidence('run_project_command', {}, { exitCode: 0, projectChanged: false });
  recordProjectAction(
    handoff,
    'run_project_command',
    { command: 'test' },
    { exitCode: 0, projectChanged: false },
    evidence.id,
    evidence.at,
  );
  updateProjectTask(
    handoff,
    {
      requirements: [{ text: 'Tests pass', status: 'passed', verification: 'command', evidenceIds: [evidence.id] }],
      remaining: '',
    },
    [evidence],
  );
  expect(handoff.requirements).toHaveLength(1);
  expect(handoff.requirements[0].status).toBe('passed');
  recordProjectAction(
    handoff,
    'run_project_command',
    { command: 'other test' },
    { exitCode: 0, projectChanged: false },
  );
  expect(handoff.requirements[0].status).toBe('passed');
  recordProjectAction(
    handoff,
    'run_project_command',
    { command: 'partial write' },
    { exitCode: 1, projectChanged: true },
  );
  expect(handoff.requirements[0].status).toBe('not_run');
});

it('requires the cited browser observation to belong to the current interaction cycle', () => {
  const handoff = newHandoff(undefined, 'Test chat');
  const url = 'http://127.0.0.1:4177';
  const old = sourceEvidence('browser_read', {}, { url, errors: [] }),
    current = sourceEvidence('browser_read', {}, { url, errors: [] });
  recordProjectAction(handoff, 'browser_open', {}, { url });
  recordProjectAction(handoff, 'browser_fill', {}, { url });
  recordProjectAction(handoff, 'browser_read', {}, { url, errors: [] }, current.id);
  const task = {
    requirements: [{ text: 'Chat works', status: 'passed', verification: 'browser', evidenceIds: [old.id] }],
    remaining: '',
  };
  expect(() => updateProjectTask(handoff, task, [old, current])).toThrow('current page');
  task.requirements[0].evidenceIds = [current.id];
  updateProjectTask(handoff, task, [old, current]);
  expect(handoff.requirements[0].status).toBe('passed');
});
it.each([
  'Thinking…',
  'Loading model…',
  'Generating response',
  'Processing request',
  'Pending',
  'Please wait',
  'Error: inference failed',
  'Failed to generate',
])('rejects unresolved inference output: %s', (replyAfter) => {
  const handoff = newHandoff(undefined, 'Test inference');
  const evidence = sourceEvidence(
    'browser_read',
    {},
    { url: 'http://127.0.0.1:4177', selected: { selector: '#reply', text: replyAfter }, errors: [] },
  );
  handoff.browser = {
    url: 'http://127.0.0.1:4177',
    openedAt: evidence.at,
    interacted: true,
    observed: true,
    observationId: evidence.id,
    readyAtInteraction: true,
    submitted: true,
    responseSelector: '#reply',
    replyBefore: '',
    replyAfter,
  };
  expect(() =>
    updateProjectTask(
      handoff,
      {
        requirements: [
          {
            text: 'Inference responds',
            stage: 'inference',
            status: 'passed',
            verification: 'browser',
            evidenceIds: [evidence.id],
          },
        ],
        remaining: '',
      },
      [evidence],
    ),
  ).toThrow('Inference needs');
});

it('explains that waiting is not a recorded post-interaction browser observation', () => {
  const handoff = newHandoff(undefined, 'Verify the webpage');
  const criterion = { text: 'The page responds', status: 'not_run', verification: 'browser', evidenceIds: [] as string[] };
  updateProjectTask(handoff, { requirements: [criterion], remaining: 'Check' }, []);
  handoff.browser = { url: 'http://127.0.0.1:4173', openedAt: Date.now(), interacted: true, observed: false };
  const wait = sourceEvidence('browser_wait', {}, { url: handoff.browser.url, errors: [], content: 'Output' });
  expect(() => updateProjectTask(handoff, { requirements: [{ ...criterion, status: 'passed', evidenceIds: [wait.id] }], remaining: '' }, [wait])).toThrow(expect.objectContaining({ code: 'BROWSER_EVIDENCE_REQUIRED', details: expect.objectContaining({ needsObservation: true, nextAction: expect.stringContaining('browser_read') }) }));
  expect(handoff.requirements[0].status).toBe('not_run');
});

it('directs a ready model observed only by waiting to the selected read before chat submission', () => {
  const handoff = newHandoff(undefined, 'Verify the local model');
  const criterion = { text: 'Model is ready', stage: 'model', selector: '#model-status', expectedText: 'Model ready', status: 'not_run', verification: 'browser', evidenceIds: [] as string[] };
  updateProjectTask(handoff, { requirements: [criterion], remaining: 'Check' }, []);
  handoff.browser = { url: 'http://127.0.0.1:4173', openedAt: Date.now(), interacted: true, observed: false };
  const wait = sourceEvidence('browser_wait', {}, { url: handoff.browser.url, errors: [], content: 'Model ready' });
  expect(() => updateProjectTask(handoff, { requirements: [{ ...criterion, status: 'passed', evidenceIds: [wait.id] }], remaining: '' }, [wait])).toThrow(expect.objectContaining({ code: 'BROWSER_OBSERVATION_REQUIRED', details: expect.objectContaining({ stage: 'model', nextAction: expect.stringContaining('BEFORE submitting any chat question') }) }));
  expect(handoff.requirements[0].status).toBe('not_run');
});

it('does not enable implementation when a metadata-only update has no saved criteria', () => {
  const handoff = newHandoff(undefined, 'Fix the app');
  expect(updateProjectTask(handoff, { requirements: [], remaining: 'Inspect sources' }, [])).toMatchObject({ implementationReady: false, verificationReady: false });
  expect(() => requireProjectContract(handoff)).toThrow('acceptance criteria');
});

it('supports documented WebLLM MLC layouts and reports actionable invalid evidence without weakening validation', () => {
  const docs = sourceEvidence('web_fetch', { url: 'https://webllm.mlc.ai/docs/' }, { content: 'WebLLM uses MLC model shards' });
  const requirements = [{ text: 'Model answers locally', status: 'not_run', verification: 'browser', stage: 'inference', evidenceIds: [] }];
  const compatibility = { runtime: 'WebLLM', version: '0.2.84', modelFormat: 'mlc', modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', maxBytes: 400000000, evidenceIds: [docs.id] };
  const handoff = newHandoff(undefined, 'Static local browser model');
  updateProjectTask(handoff, { requirements, compatibility, remaining: 'Implement' }, [docs]);
  expect(handoff.compatibility?.modelFormat).toBe('mlc');
  const taskState = sourceEvidence('read_project_task', {}, readProjectTask(handoff));
  expect(() => updateProjectTask(handoff, { requirements: [], compatibility: { ...compatibility, version: 'invented', evidenceIds: [taskState.id] }, compatibilityCorrection: 'Claimed correction', remaining: '' }, [docs, taskState])).toThrow('successful source');
  for (const model of [{ runtime: 'WebLLM', modelFormat: 'onnx' }, { runtime: 'Transformers.js', modelFormat: 'mlc' }]) {
    expect(() => updateProjectTask(newHandoff(undefined, 'Browser model'), { requirements, compatibility: { ...compatibility, ...model }, remaining: '' }, [docs])).toThrow('ONNX');
  }
  try {
    updateProjectTask(newHandoff(undefined, 'Browser model'), { requirements, compatibility: { ...compatibility, evidenceIds: ['invented'] }, remaining: '' }, [docs]);
    throw new Error('Expected evidence rejection');
  } catch (error: any) {
    expect(error.code).toBe('COMPATIBILITY_EVIDENCE_REQUIRED');
    expect(error.details.invalidEvidenceIds).toEqual(['invented']);
    expect(error.details.availableSources[0].evidenceId).toBe(docs.id);
  }
});

it('allows explicit runtime version repairs with new evidence and resets verification while preserving model scope', () => {
  const oldDocs = sourceEvidence('web_fetch', { url: 'https://example.org/old' }, { content: 'Old runtime documentation' });
  const newDocs = sourceEvidence('web_fetch', { url: 'https://example.org/package' }, { content: 'WebLLM version 0.2.87' });
  const evidence = [oldDocs, newDocs];
  const handoff = newHandoff(undefined, 'Local Qwen model');
  const requirements = [{ text: 'Local model works', status: 'not_run', verification: 'inspection', evidenceIds: [] }];
  const compatibility = { runtime: 'WebLLM', version: '0.5.50', modelFormat: 'mlc', modelId: 'Qwen', maxBytes: 300000000, evidenceIds: [oldDocs.id] };
  updateProjectTask(handoff, { requirements, compatibility, remaining: '' }, evidence);
  handoff.requirements[0].status = 'passed';
  handoff.requirements[0].evidenceIds = [oldDocs.id];
  const correction = { requirements: [], compatibility: { ...compatibility, version: '0.2.87', evidenceIds: [newDocs.id] }, compatibilityCorrection: 'The original version does not exist; package metadata verifies 0.2.87.', remaining: 'Retest' };
  expect(() => updateProjectTask(handoff, { ...correction, compatibilityCorrection: undefined }, evidence)).toThrow('version repair');
  expect(() => updateProjectTask(handoff, { ...correction, compatibility: { ...correction.compatibility, evidenceIds: [oldDocs.id] } }, evidence)).toThrow('version repair');
  expect(() => updateProjectTask(handoff, { ...correction, compatibility: { ...correction.compatibility, maxBytes: 400000000 } }, evidence)).toThrow('byte limit');
  updateProjectTask(handoff, correction, evidence);
  expect(handoff.compatibility?.version).toBe('0.2.87');
  expect(handoff.generation).toBe(1);
  expect(handoff.requirements[0]).toMatchObject({ status: 'not_run', evidenceIds: [] });
  expect(readProjectTask(handoff)).toMatchObject({ compatibility: { version: '0.2.87' }, requirements: [{ text: 'Local model works', status: 'not_run' }], remaining: 'Retest' });
});

it('verifies compatibility, page loading, model readiness and fresh inference separately, then invalidates after editing', () => {
  const handoff = newHandoff(undefined, 'Run a GGUF model in the browser');
  const evidence: ReturnType<typeof sourceEvidence>[] = [];
  const observe = (name: string, result: unknown, args: unknown = {}) => {
    const item = sourceEvidence(name, args, result);
    evidence.push(item);
    recordProjectAction(handoff, name, args, result, item.id, item.at);
    item.projectRevision = handoff.generation ?? 0;
    return item;
  };
  const requirements = [
    { text: 'Page loads', stage: 'page', status: 'not_run', verification: 'browser', evidenceIds: [] as string[] },
    {
      text: 'Requested model loads',
      stage: 'model',
      selector: '#model-status',
      expectedText: 'Model ready',
      status: 'not_run',
      verification: 'browser',
      evidenceIds: [] as string[],
    },
    {
      text: 'Model answers a question',
      stage: 'inference',
      status: 'not_run',
      verification: 'browser',
      evidenceIds: [] as string[],
    },
  ];
  const docs = observe(
    'read_project_file',
    { path: 'runtime.md', hash: 'docs', content: 'wllama supports GGUF inference' },
    { path: 'runtime.md' },
  );
  const compatibility = {
    runtime: 'wllama',
    version: '2.3.0',
    modelFormat: 'gguf',
    modelId: 'requested/model',
    maxBytes: 1000000,
    evidenceIds: [docs.id],
  };
  expect(() =>
    updateProjectTask(
      handoff,
      { requirements, compatibility: { ...compatibility, runtime: 'Transformers.js' }, remaining: 'Implement' },
      evidence,
    ),
  ).toThrow('ONNX');
  updateProjectTask(handoff, { requirements, compatibility, remaining: 'Implement' }, evidence);
  expect(() => requireProjectContract(handoff)).not.toThrow();
  const url = 'http://127.0.0.1:4177';
  const opened = observe('browser_open', { url, errors: [] });
  updateProjectTask(
    handoff,
    { requirements: [{ ...requirements[0], status: 'passed', evidenceIds: [opened.id] }], remaining: 'Load model' },
    evidence,
  );
  expect(handoff.requirements.find((item) => item.stage === 'page')?.status).toBe('passed');
  expect(handoff.requirements.find((item) => item.stage === 'inference')?.status).toBe('not_run');
  const loading = observe('browser_read', {
    url,
    errors: [],
    selected: { selector: '#model-status', text: 'Loading model' },
  });
  expect(() =>
    updateProjectTask(
      handoff,
      { requirements: [{ ...requirements[1], status: 'passed', evidenceIds: [loading.id] }], remaining: '' },
      evidence,
    ),
  ).toThrow('loaded-model indicator');
  const ready = observe('browser_read', {
    url,
    errors: [],
    selected: { selector: '#model-status', text: 'Model ready' },
  });
  updateProjectTask(
    handoff,
    { requirements: [{ ...requirements[1], status: 'passed', evidenceIds: [ready.id] }], remaining: 'Ask a question' },
    evidence,
  );
  expect(() =>
    updateProjectTask(
      handoff,
      { requirements: [{ ...requirements[2], status: 'passed', evidenceIds: [ready.id] }], remaining: '' },
      evidence,
    ),
  ).toThrow('Inference needs');
  observe('browser_fill', { url, submitted: true, responseSelector: '#reply', replyBefore: '' });
  const reply = observe('browser_read', {
    url,
    errors: [],
    selected: { selector: '#reply', text: 'The answer is 42.' },
  });
  updateProjectTask(
    handoff,
    { requirements: [{ ...requirements[2], status: 'passed', evidenceIds: [reply.id] }], remaining: '' },
    evidence,
  );
  expect(handoff.requirements.every((item) => item.status === 'passed')).toBe(true);
  recordProjectAction(handoff, 'patch_project_file', { path: 'index.html' }, { path: 'index.html', hash: 'new' });
  expect(handoff.browser).toBeUndefined();
  expect(handoff.requirements.every((item) => item.status === 'not_run')).toBe(true);
  expect(() =>
    updateProjectTask(
      handoff,
      { requirements: [{ ...requirements[2], status: 'passed', evidenceIds: [reply.id] }], remaining: '' },
      evidence,
    ),
  ).toThrow('current evidence');
});

it('allows failed checks across genuine edits while preserving the recovery allowance', () => {
  const progress = new ProjectProgress();
  const fail = () => progress.observe('run_project_command', { command: 'npm test' }, { exitCode: 1 });
  expect(fail()).toBeUndefined();
  progress.observe('patch_project_file', { path: 'app.js' }, { previousHash: 'a', hash: 'b' });
  expect(fail()).toBeUndefined();
  progress.observe('patch_project_file', { path: 'app.js' }, { previousHash: 'b', hash: 'c' });
  expect(fail()).toBeUndefined();
  expect(fail()).toBeUndefined();
  expect(fail()).toContain('MERCURY RECOVERY');
  progress.observe('patch_project_file', { path: 'app.js' }, { previousHash: 'c', hash: 'd' });
  expect(progress.recoveries).toBe(1);
  progress.dispose();
});
it.each([
  { previousHash: 'a', hash: 'a' },
  { verificationUnknown: true, projectChange: 'unknown' },
])('does not reset failures after no-op or unknown observations: %j', (result) => {
  const progress = new ProjectProgress();
  const fail = () => progress.observe('run_project_command', { command: 'npm test' }, { exitCode: 1 });
  expect(fail()).toBeUndefined();
  progress.observe('patch_project_file', { path: 'app.js' }, result);
  expect(fail()).toBeUndefined();
  progress.observe('patch_project_file', { path: 'app.js' }, result);
  expect(fail()).toContain('MERCURY RECOVERY');
  progress.dispose();
});
