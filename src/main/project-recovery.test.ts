import { expect, it, vi } from 'vitest';
import { ProjectProgress, ProjectStalledError, projectActionIdentity, verifiedPreviewRecovery } from './project-progress';
import { resolvesHandoffBlocker, resolvesProgressBlocker } from './project-recovery';
import * as recoveryOwner from './project-recovery';
import * as progressFacade from './project-progress';

it('resolves a verified preview after correcting its working directory only for the same command', () => {
  const blocker = { tool: 'start_project_server', target: 'static-export', code: 'SERVER_START_FAILED' };
  const result = { id: 'preview', running: true, url: 'http://127.0.0.1:4176/' };
  const failedArgs = { command: 'node static-server.cjs', cwd: 'static-export', port: 4173 };
  expect(resolvesHandoffBlocker(blocker, 'start_project_server', { command: 'node static-server.cjs', port: 4176 }, '.', result, failedArgs)).toBe(true);
  expect(resolvesHandoffBlocker(blocker, 'start_project_server', { command: 'node unrelated.cjs' }, '.', result, failedArgs)).toBe(false);
  expect(resolvesHandoffBlocker(blocker, 'start_project_server', { command: 'node static-server.cjs' }, '.', { ...result, running: false }, failedArgs)).toBe(false);
});

it('resolves git add after removing exactly the pathspec reported missing', () => {
  const failedArgs = { command: 'git add models/*.bin static-export/static-chat.html .gitattributes 2>&1' };
  const blocker = { tool: 'run_project_command', target: '.', code: 'COMMAND_EXIT_128', message: "fatal: pathspec 'static-export/static-chat.html' did not match any files\n", action: projectActionIdentity('run_project_command', failedArgs) };
  expect(resolvesHandoffBlocker(blocker, 'run_project_command', { command: 'git add models/*.bin .gitattributes 2>&1' }, '.', { exitCode: 0 }, failedArgs)).toBe(true);
  for (const command of ['git status', 'git add .gitattributes', 'git add models/*.bin unrelated.txt .gitattributes', 'git add models/*.bin .gitattributes && echo ok']) {
    expect(resolvesHandoffBlocker(blocker, 'run_project_command', { command }, '.', { exitCode: 0 }, failedArgs)).toBe(false);
  }
  expect(resolvesHandoffBlocker(blocker, 'run_project_command', { command: 'git add models/*.bin .gitattributes' }, 'other', { exitCode: 0 }, failedArgs)).toBe(false);
});

it.each([
  { name: 'start_project_server', failedArgs: { command: 'node static-server.cjs', cwd: 'static-export' }, failed: { error: 'Server exited with code 1.', code: 'SERVER_START_FAILED' }, args: { command: 'node static-server.cjs' }, result: { id: 'preview', running: true, url: 'http://127.0.0.1:4176/' } },
  { name: 'run_project_command', failedArgs: { command: 'git add models/*.bin missing.html .gitattributes' }, failed: { exitCode: 128, output: "fatal: pathspec 'missing.html' did not match any files\n" }, args: { command: 'git add models/*.bin .gitattributes' }, result: { exitCode: 0 } },
])('cancels repeated-failure recovery after the corrected $name operation', async ({ name, failedArgs, failed, args, result }) => {
  vi.useFakeTimers();
  const stopped = vi.fn(), progress = new ProjectProgress({ providerLimitMs: 100, onStall: stopped });
  try {
    for (let index = 0; index < 2; index++) expect(progress.observe(name, failedArgs, failed)).toBeUndefined();
    expect(progress.observe(name, failedArgs, failed)).toContain('MERCURY RECOVERY');
    progress.providerState('running');
    progress.attempt();
    expect(progress.observe(name, args, result)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    for (let index = 0; index < 12; index++) expect(() => progress.attempt()).not.toThrow();
    expect(stopped).not.toHaveBeenCalled();
    expect(progress.recoveries).toBe(1);
  } finally { progress.dispose(); vi.useRealTimers(); }
});

it('keeps the recovery timer after an unrelated successful command', async () => {
  vi.useFakeTimers();
  const stopped = vi.fn(), progress = new ProjectProgress({ providerLimitMs: 100, onStall: stopped });
  try {
    for (let index = 0; index < 3; index++) progress.observe('run_project_command', { command: 'git add models/*.bin missing.html' }, { exitCode: 128, output: "fatal: pathspec 'missing.html' did not match any files\n" });
    progress.providerState('running');
    progress.observe('run_project_command', { command: 'git status' }, { exitCode: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toHaveBeenCalledOnce();
    expect(() => progress.attempt()).toThrow(ProjectStalledError);
  } finally { progress.dispose(); vi.useRealTimers(); }
});

it('resolves a command blocker through the equivalent structured operation', () => {
  const progress = new ProjectProgress({ maxAttempts: 1 });
  try {
    const args = { command: 'npm run "build"' };
    progress.recover('build failed', 'run_project_command', '.', false, {
      action: projectActionIdentity('run_project_command', args), failureCode: 'COMMAND_EXIT_1',
    });
    progress.attempt();
    expect(progress.observe('run_project_process', { executable: 'npm', args: ['run', 'build'] }, { exitCode: 0 })).toBeUndefined();
    for (let index = 0; index < 10; index++) expect(() => progress.attempt()).not.toThrow();
    expect(progress.recoveries).toBe(1);
  } finally { progress.dispose(); }
});

it('rejects another recovery after a successful repair without resetting its allowance', () => {
  const progress = new ProjectProgress();
  try {
    progress.recover('first', 'patch_project_file', 'app.ts');
    progress.observe('patch_project_file', { path: 'app.ts' }, { previousHash: 'a', hash: 'b' });
    expect(() => progress.recover('second')).toThrow(ProjectStalledError);
    expect(() => progress.attempt()).toThrow('second after one recovery attempt. Work is preserved; no model was switched.');
  } finally { progress.dispose(); }
});

it('keeps queued and idle time outside the shared provider recovery budget', async () => {
  vi.useFakeTimers();
  const stopped = vi.fn();
  const progress = new ProjectProgress({ providerLimitMs: 100, onStall: stopped });
  try {
    progress.recover('blocked');
    progress.providerState('queued');
    await vi.advanceTimersByTimeAsync(1000);
    progress.providerState('running');
    await vi.advanceTimersByTimeAsync(60);
    progress.providerState('idle');
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).not.toHaveBeenCalled();
    progress.providerState('running');
    await vi.advanceTimersByTimeAsync(40);
    expect(stopped).toHaveBeenCalledOnce();
    expect(() => progress.attempt()).toThrow(ProjectStalledError);
  } finally { progress.dispose(); vi.useRealTimers(); }
});

it('requires a successful managed loopback preview on the same target', () => {
  const blocker = { tool: 'start_project_server', target: '.' };
  const result = { id: 'preview', running: true, url: 'http://127.0.0.1:4173/' };
  expect(verifiedPreviewRecovery(blocker, 'start_project_server', '.', result)).toBe(true);
  expect(verifiedPreviewRecovery(blocker, 'start_project_server', 'other', result)).toBe(false);
  expect(verifiedPreviewRecovery(blocker, 'start_project_server', '.', { ...result, exitCode: 1 })).toBe(false);
});

it('uses result target precedence and preserves the unchanged-patch action fallback', () => {
  const progress = new ProjectProgress({ maxAttempts: 1 });
  try {
    const args = { path: 'app.ts' };
    progress.recover('patch failed', 'patch_project_file', 'app.ts', false, {
      action: projectActionIdentity('patch_project_file', args), failureCode: 'PATCH_NO_MATCH',
    });
    progress.attempt();
    expect(progress.observe('patch_project_file', args, { target: 'other.ts', previousHash: 'same', hash: 'same' })).toBeUndefined();
    expect(() => progress.attempt()).not.toThrow();
  } finally { progress.dispose(); }
});

it('accepts normalized result targets for legacy progress blockers but does not treat changed reads as patch repair', () => {
  const repaired = new ProjectProgress({ maxAttempts: 1 });
  const pending = new ProjectProgress({ maxAttempts: 1 });
  try {
    repaired.recover('legacy', 'edit_project_file', 'folder/app.ts');
    repaired.attempt();
    repaired.observe('edit_project_file', { path: 'wrong.ts' }, { target: 'folder\\app.ts' });
    expect(() => repaired.attempt()).not.toThrow();
    pending.recover('patch', 'patch_project_file', 'app.ts');
    pending.attempt();
    expect(() => pending.observe('read_project_file', { path: 'app.ts' }, { hash: 'changed' })).toThrow(ProjectStalledError);
  } finally { repaired.dispose(); pending.dispose(); }
});

const patchBlocker = { name: 'patch_project_file', target: 'folder/app.ts', evidence: false, action: 'unmatched', failureCode: 'PATCH_NO_MATCH' };
const commandArgs = { command: 'npm test' };
const commandAction = projectActionIdentity('run_project_command', commandArgs);
it.each([
  { route: 'file repair', blocker: patchBlocker, name: 'edit_project_file', args: {}, target: 'folder/app.ts', result: { hash: 'b', previousHash: 'a' }, expected: true },
  { route: 'file repair unchanged hash', blocker: patchBlocker, name: 'edit_project_file', args: {}, target: 'folder/app.ts', result: { hash: 'a', previousHash: 'a' }, expected: false },
  { route: 'file repair missing previous hash', blocker: patchBlocker, name: 'edit_project_file', args: {}, target: 'folder/app.ts', result: { hash: 'b' }, expected: true },
  { route: 'process repair', blocker: patchBlocker, name: 'run_project_process', args: {}, target: '.', result: { projectChanged: true, changedPaths: ['folder\\app.ts'] }, expected: true },
  { route: 'process repair other file', blocker: patchBlocker, name: 'run_project_process', args: {}, target: '.', result: { projectChanged: true, changedPaths: ['other.ts'] }, expected: false },
  { route: 'process repair ignores nonstrings', blocker: patchBlocker, name: 'run_project_command', args: {}, target: '.', result: { projectChanged: true, changedPaths: [null, 1, 'folder/app.ts'] }, expected: true },
  { route: 'preview', blocker: { ...patchBlocker, name: 'start_project_server' }, name: 'start_project_server', args: {}, target: 'folder/app.ts', result: { id: 'p', running: true, url: 'http://127.0.0.1:4173' }, expected: true },
  { route: 'preview external URL', blocker: { ...patchBlocker, name: 'start_project_server' }, name: 'start_project_server', args: {}, target: 'folder/app.ts', result: { id: 'p', running: true, url: 'https://example.org' }, expected: false },
  { route: 'preview missing id', blocker: { ...patchBlocker, name: 'start_project_server' }, name: 'start_project_server', args: {}, target: 'folder/app.ts', result: { running: true, url: 'http://127.0.0.1:4173/' }, expected: false },
  { route: 'fresh evidence', blocker: { ...patchBlocker, evidence: true }, name: 'read_project_file', args: {}, target: 'other.ts', result: {}, newEvidence: true, expected: true },
  { route: 'repeated evidence', blocker: { ...patchBlocker, evidence: true }, name: 'read_project_file', args: {}, target: 'other.ts', result: {}, newEvidence: false, expected: false },
  { route: 'evidence precedence over action', blocker: { ...patchBlocker, evidence: true, action: projectActionIdentity('read_project_file', {}) }, name: 'read_project_file', args: {}, target: '.', result: {}, expected: false },
  { route: 'action identity', blocker: { ...patchBlocker, name: 'run_project_command', action: commandAction }, name: 'run_project_process', args: { executable: 'npm', args: ['test'] }, target: '.', result: { exitCode: 0 }, expected: true },
  { route: 'action identity unrelated command', blocker: { ...patchBlocker, name: 'run_project_command', action: commandAction }, name: 'run_project_command', args: { command: 'npm run build' }, target: '.', result: { exitCode: 0 }, expected: false },
  { route: 'action identity ignores observed target', blocker: { ...patchBlocker, name: 'run_project_command', action: commandAction }, name: 'run_project_command', args: commandArgs, target: 'elsewhere', result: {}, expected: true },
  { route: 'legacy tool', blocker: { ...patchBlocker, action: undefined, name: 'read_project_file' }, name: 'read_project_file', args: {}, target: 'folder/app.ts', result: {}, expected: true },
  { route: 'legacy tool wrong target', blocker: { ...patchBlocker, action: undefined, name: 'read_project_file' }, name: 'read_project_file', args: {}, target: 'other.ts', result: {}, expected: false },
  { route: 'legacy empty action', blocker: { ...patchBlocker, action: '', name: 'read_project_file' }, name: 'read_project_file', args: {}, target: 'folder/app.ts', result: {}, expected: true },
  { route: 'legacy process', blocker: { ...patchBlocker, action: undefined, name: 'run_project_command' }, name: 'run_project_process', args: {}, target: 'folder/app.ts', result: {}, expected: true },
  { route: 'legacy process wrong direction', blocker: { ...patchBlocker, action: undefined, name: 'run_project_process' }, name: 'run_project_command', args: {}, target: 'folder/app.ts', result: {}, expected: false },
  { route: 'legacy process wrong target', blocker: { ...patchBlocker, action: undefined, name: 'run_project_command' }, name: 'run_project_process', args: {}, target: '.', result: {}, expected: false },
])('preserves progress resolution route: $route', ({ blocker, name, args, target, result, newEvidence, expected }) => {
  expect(resolvesProgressBlocker(blocker, name, args, target, result, newEvidence)).toBe(expected);
  expect(resolvesProgressBlocker(blocker, name, args, target, { ...result, error: 'failed' }, newEvidence)).toBe(false);
});

const handoffBlocker = { tool: 'patch_project_file', target: 'app.ts', code: 'PATCH_NO_MATCH', sourceRevision: 'old' };
it.each([
  { route: 'preview', blocker: { ...handoffBlocker, tool: 'start_project_server' }, name: 'start_project_server', args: {}, target: 'app.ts', result: { id: 'p', running: true, url: 'http://127.0.0.1:4173/' }, expected: true },
  { route: 'preview wrong target', blocker: { ...handoffBlocker, tool: 'start_project_server' }, name: 'start_project_server', args: {}, target: 'other.ts', result: { id: 'p', running: true, url: 'http://127.0.0.1:4173/' }, expected: false },
  { route: 'preview normalizes Windows paths', blocker: { ...handoffBlocker, tool: 'start_project_server', target: 'Folder\\App.ts' }, name: 'start_project_server', args: {}, target: 'folder/app.ts', result: { id: 'p', running: true, url: 'http://127.0.0.1:4173/' }, expected: process.platform === 'win32' },
  { route: 'matching action', blocker: { ...handoffBlocker, action: projectActionIdentity('patch_project_file', { path: 'app.ts' }) }, name: 'patch_project_file', args: { path: 'app.ts' }, target: 'app.ts', result: { hash: 'old' }, expected: true },
  { route: 'action mismatch prevents tool fallback', blocker: { ...handoffBlocker, action: 'other' }, name: 'patch_project_file', args: { path: 'app.ts' }, target: 'app.ts', result: {}, expected: false },
  { route: 'legacy matching tool', blocker: handoffBlocker, name: 'patch_project_file', args: {}, target: 'app.ts', result: {}, expected: true },
  { route: 'raw targets stay case sensitive', blocker: handoffBlocker, name: 'patch_project_file', args: {}, target: 'APP.ts', result: {}, expected: false },
  { route: 'validation failure retains legacy action fallback', blocker: handoffBlocker, name: 'patch_project_file', args: {}, target: 'app.ts', result: { error: 'invalid', code: 'INVALID_ARGUMENTS' }, expected: true },
  { route: 'changed source read', blocker: { ...handoffBlocker, action: 'other' }, name: 'read_project_file', args: {}, target: 'app.ts', result: { hash: 'new' }, expected: true },
  { route: 'unchanged source read', blocker: handoffBlocker, name: 'read_project_file', args: {}, target: 'app.ts', result: { hash: 'old' }, expected: false },
  { route: 'empty source hash', blocker: handoffBlocker, name: 'read_project_file', args: {}, target: 'app.ts', result: { hash: '' }, expected: false },
  { route: 'changedPaths is not a handoff route', blocker: handoffBlocker, name: 'run_project_process', args: {}, target: 'app.ts', result: { projectChanged: true, changedPaths: ['app.ts'] }, expected: false },
])('preserves persisted resolution route: $route', ({ blocker, name, args, target, result, expected }) => {
  expect(resolvesHandoffBlocker(blocker, name, args, target, result)).toBe(expected);
});

it('does not resolve absent blockers', () => {
  expect(resolvesProgressBlocker(undefined, 'read_project_file', {}, '.', {})).toBe(false);
  expect(resolvesHandoffBlocker(undefined, 'read_project_file', {}, '.', {})).toBe(false);
});
it('keeps facade constructor identity after extraction', () => {
  expect(progressFacade.ProjectProgress).toBe(recoveryOwner.ProjectProgress);
  expect(progressFacade.ProjectStalledError).toBe(recoveryOwner.ProjectStalledError);
  expect(new progressFacade.ProjectStalledError('stalled')).toBeInstanceOf(recoveryOwner.ProjectStalledError);
});
