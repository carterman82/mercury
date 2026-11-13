import { expect, it, vi } from 'vitest';
import { ChatService } from './chat';
import { newHandoff } from './project-progress';
import type { ChatThread } from '../shared/types';
import type { Store } from './store';
import type { ModelProvider } from './providers';
import type { ProjectTools } from './project-tools';
import type { ProjectAgentRuntime } from './project-agent-runtime';

// Observation behavior requires room for the complete registered tool catalog.
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 32000 };
async function observe(name: string, args: object, output: object, changed = false, attempts = 1, following: { name: string; args: object; output: object }[] = [], runtimeError?: string, requirementStatus: 'passed' | 'not_run' = 'passed', afterObservations?: (input: Parameters<ProjectAgentRuntime['run']>[0], replies: any[], chat: ChatThread) => Promise<void>) {
  const handoff = newHandoff(undefined, 'Review source');
  handoff.requirements = [{ text: 'Reviewed', verification: 'inspection', status: requirementStatus, evidenceIds: ['prior'] }];
  const chat: ChatThread = { id: 'chat', projectId: 'project', title: 'Review', profile, messages: [], status: 'idle', updatedAt: 1, projectHandoff: handoff };
  let generation = 0;
  let nextOutput = output;
  const replies: any[] = [];
  const store = { settings: () => ({ connections: [{ id: 'fixture', provider: 'ollama', url: 'http://unused.invalid' }] }), chat: () => chat, project: () => ({ id: 'project', permissionMode: 2 }), saveChat: vi.fn() } as unknown as Store;
  const projects = { prepare: async () => 'Project source', loadWorkflows: async () => ({ context: '', loaded: [], warnings: [] }), generation: () => generation, handles: () => true, execute: async () => { if (changed) generation++; return nextOutput; }, commitResponse: async () => ({ committed: false }) } as unknown as ProjectTools;
  let runs = 0;
  const runtime = { run: async input => {
    if (runs++ > 0) { input.onText?.("Checks remain incomplete."); return { text: "Checks remain incomplete." }; }
    for (let index = 0; index < attempts; index++) replies.push(await input.execute(name, args));
    for (const call of following) { nextOutput = call.output; replies.push(await input.execute(call.name, call.args)); }
    await afterObservations?.(input, replies, chat);
    input.onText?.('The requested source review is complete.');
    if (runtimeError) throw new Error(runtimeError);
    return { text: 'The requested source review is complete.' };
  } } as ProjectAgentRuntime;
  await new ChatService(store, {} as ModelProvider, () => {}, () => false, undefined, undefined, projects, runtime).send(chat.id, profile, 'Review source');
  return { chat, handoff, replies, response: chat.messages.at(-1)! };
}

it.each(['fresh', 'old', 'mixed', 'missing', 'failed', 'stale-revision', 'before-mutation', 'malformed', 'runtime-failure'] as const)('supersedes an old failed operation only with complete fresh verification: %s', async mode => {
  let now = 100;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
  try {
    const { chat, response, handoff } = await observe('read_project_file', { path: 'old.ts' }, { content: 'old successful inspection', hash: 'old' }, false, 1, [
      { name: 'read_project_file', args: { path: 'mistaken/optional.ts' }, output: { error: 'ENOENT: no such file', code: 'TOOL_ERROR' } },
      { name: 'read_project_file', args: { path: 'actual/source.ts' }, output: { content: 'current inspected source', hash: 'current' } },
    ], mode === 'runtime-failure' ? 'Project SDK run failed: error_during_execution' : undefined, 'not_run', async (input, replies, current) => {
      const ids = mode === 'old' ? [replies[0].evidenceId] : mode === 'mixed' ? [replies[2].evidenceId, replies[0].evidenceId] : [replies[2].evidenceId];
      const result = await input.execute('update_project_task', { requirements: [{ ...current.projectHandoff!.requirements[0], status: 'passed', evidenceIds: ids }], remaining: '' });
      expect(result).not.toHaveProperty('error');
      const selected = current.messages.at(-1)!.sourceEvidence!.find(item => item.id === replies[2].evidenceId)!;
      // Simulate persisted evidence becoming unavailable/stale after an otherwise
      // valid status update; delivery must independently check every reference.
      if (mode === 'missing') current.messages.at(-1)!.sourceEvidence = current.messages.at(-1)!.sourceEvidence!.filter(item => item.id !== selected.id);
      if (mode === 'failed') selected.result = JSON.stringify({ exitCode: 1 });
      if (mode === 'stale-revision') selected.projectRevision = -1;
      if (mode === 'before-mutation') current.projectHandoff!.lastMutationAt = selected.at + 1;
      if (mode === 'malformed') selected.result = '{invalid';
    });
    expect(chat.status).toBe(mode === 'fresh' ? 'idle' : 'failed');
    expect(response.delivery?.status).toBe(mode === 'fresh' ? 'completed' : 'blocked');
    expect(handoff.failedApproaches).toHaveLength(1);
    expect(response.toolActivity?.some(item => item.status === 'failed')).toBe(true);
    if (mode === 'fresh') expect(handoff.blocker).toBeUndefined();
  } finally { clock.mockRestore(); }
});

it('completes delivery after a corrected managed preview without erasing failed tool history', async () => {
  const { chat, handoff, response } = await observe('start_project_server', { command: 'node static-server.cjs', cwd: 'static-export', port: 4173 }, { error: 'Server exited with code 1.', code: 'SERVER_START_FAILED' }, false, 1, [
    { name: 'start_project_server', args: { command: 'node static-server.cjs', port: 4176 }, output: { id: 'preview', running: true, url: 'http://127.0.0.1:4176' } },
  ]);
  expect(handoff.blocker).toBeUndefined();
  expect(chat.status).toBe('idle');
  expect(response.delivery?.status).toBe('completed');
  expect(response.toolActivity?.map(item => item.status)).toEqual(['failed', 'succeeded']);
  expect(handoff.failedApproaches).toHaveLength(1);
});

it.each([
  ['git add models/*.bin .gitattributes 2>&1', 'idle', 'completed'],
  ['git status', 'failed', 'blocked'],
] as const)('keeps delivery scoped to the recovered git operation: %s', async (command, status, delivery) => {
  const { chat, response } = await observe('run_project_command', { command: 'git add models/*.bin static-export/static-chat.html .gitattributes 2>&1' }, { exitCode: 128, output: "fatal: pathspec 'static-export/static-chat.html' did not match any files\n" }, false, 1, [
    { name: 'run_project_command', args: { command }, output: { exitCode: 0, output: '' } },
  ]);
  expect(chat.status).toBe(status);
  expect(response.delivery?.status).toBe(delivery);
  expect(response.toolActivity?.map(item => item.status)).toEqual(['failed', 'succeeded']);
});

it('does not turn a true runtime failure into completed delivery after command recovery', async () => {
  const { chat, response } = await observe('run_project_command', { command: 'npm test' }, { exitCode: 1, output: 'failed' }, false, 1, [
    { name: 'run_project_command', args: { command: 'npm test' }, output: { exitCode: 0 } },
  ], 'Project SDK run failed: error_during_execution');
  expect(chat.projectHandoff?.blocker).toBeUndefined();
  expect(chat.status).toBe('failed');
  expect(response.delivery).toMatchObject({ status: 'blocked', reason: 'Project SDK run failed: error_during_execution' });
  expect(response.verification).toBe('blocked');
});

it('preserves incomplete acceptance requirements after a successful recovery', async () => {
  const { chat, response } = await observe('start_project_server', { command: 'node static-server.cjs', cwd: 'static-export' }, { error: 'Server exited with code 1.', code: 'SERVER_START_FAILED' }, false, 1, [
    { name: 'start_project_server', args: { command: 'node static-server.cjs' }, output: { id: 'preview', running: true, url: 'http://127.0.0.1:4176' } },
  ], undefined, 'not_run');
  expect(chat.projectHandoff?.blocker).toBeUndefined();
  expect(chat.status).toBe('failed');
  expect(response.delivery).toMatchObject({ status: 'blocked', reason: expect.stringContaining('acceptance requirements remain') });
});

it('records source evidence before generation enrichment and invalidates uncertain verification', async () => {
  const { handoff, replies, response } = await observe('run_project_process', { executable: 'node', args: [] }, { exitCode: 1, output: 'check failed', projectChange: 'unknown' }, true);
  const evidence = response.sourceEvidence![0];
  const captured = JSON.parse(evidence.result);
  expect(captured).toMatchObject({ exitCode: 1, code: 'COMMAND_EXIT_1', sourceRevision: 'unknown' });
  expect(captured).not.toHaveProperty('verificationUnknown');
  expect(captured).not.toHaveProperty('projectChanged');
  expect(replies[0]).toMatchObject({ code: 'COMMAND_EXIT_1', verificationUnknown: true, evidenceId: evidence.id });
  expect(replies[0]).not.toHaveProperty('projectChanged');
  expect(evidence.projectRevision).toBe(1);
  expect(handoff.requirements[0].status).toBe('not_run');
  expect(handoff.blocker).toMatchObject({ code: 'COMMAND_EXIT_1', tool: 'run_project_process' });
  expect(JSON.parse(response.toolActivity![0].result!)).not.toHaveProperty('verificationUnknown');
});

it('records shared changes before the actual observation without inventing another evidence entry', async () => {
  const { handoff, response, replies } = await observe('read_project_file', { path: 'app.ts' }, { hash: 'new', content: 'current source' }, true);
  expect(response.sourceEvidence).toHaveLength(1);
  expect(handoff.generation).toBe(1);
  expect(handoff.checks).toEqual([expect.objectContaining({ name: 'Shared project changes (worker or another chat)', status: 'passed' })]);
  expect(handoff.reads).toContainEqual(expect.objectContaining({ path: 'app.ts', hash: 'new' }));
  expect(response.sourceEvidence![0].projectRevision).toBe(1);
  expect(replies[0].evidenceId).toBe(response.sourceEvidence![0].id);
});

it('adds recovery metadata after evidence capture and preserves every failed observation', async () => {
  const { response, replies } = await observe('read_project_file', { path: 'app.ts' }, { error: 'read failed' }, false, 3);
  expect(response.sourceEvidence).toHaveLength(3);
  expect(response.metrics!.recoveries).toBe(1);
  expect(replies[2]).toMatchObject({ code: 'TOOL_ERROR', recovery: expect.stringContaining('MERCURY RECOVERY'), evidenceId: response.sourceEvidence![2].id });
  expect(JSON.parse(response.sourceEvidence![2].result)).not.toHaveProperty('recovery');
});
