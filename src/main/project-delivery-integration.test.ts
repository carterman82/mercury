import { expect, it, vi } from 'vitest';
import { ChatService } from './chat';
import { newHandoff } from './project-handoff';
import type { ChatThread } from '../shared/types';
import type { Store } from './store';
import type { ModelProvider } from './providers';
import type { ProjectTools } from './project-tools';
import type { ProjectAgentRuntime } from './project-agent-runtime';

it.each(['verified', 'assessed', 'unfinished'])(
  'continues a premature final to test and close criteria, with bounded retries (repair=%s)',
  async (mode) => {
    const repair = mode !== 'unfinished';
    const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 16000 };
    const handoff = newHandoff(undefined, 'Fix behavior');
    handoff.requirements = [
      { text: 'Regression test passes', verification: 'command', status: 'not_run', evidenceIds: [] },
    ];
    const chat: ChatThread = {
      id: 'chat',
      projectId: 'p',
      title: 'Fix',
      profile,
      messages: [],
      status: 'idle',
      updatedAt: 1,
      projectHandoff: handoff,
    };
    const store = {
      settings: () => ({ connections: [{ id: 'fixture', provider: 'ollama', url: 'http://unused.invalid' }] }),
      chat: () => chat,
      project: () => ({ id: 'p', permissionMode: 2 }),
      saveChat: vi.fn(),
    } as unknown as Store;
    let generation = 0;
    const commitResponse = vi.fn(async () => ({ committed: false }));
    const projects = {
      prepare: async () => 'Project',
      loadWorkflows: async () => ({ context: '', loaded: [], warnings: [] }),
      generation: () => generation,
      handles: () => true,
      execute: async (_chat: unknown, name: string) =>
        name === 'patch_project_file'
          ? (++generation, { path: 'app.ts', hash: 'new' })
          : { exitCode: 0, output: '1 regression test passed', projectChange: 'unchanged' },
      commitResponse,
    } as unknown as ProjectTools;
    let runs = 0;
    const runtime = {
      run: async (input) => {
        if (++runs === 1) {
          await input.execute('update_project_task', { requirements: handoff.requirements, remaining: 'Implement' });
          await input.execute('patch_project_file', { path: 'app.ts', oldText: 'old', newText: 'fixed' });
        }
        else {
          expect(input.messages.at(-1)?.content).toContain('Delivery is not yet verified');
          if (mode === 'assessed') {
            const state: any = await input.execute('update_project_task', { requirements: [], remaining: 'Finish' });
            expect(input.tools).toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: 'complete_project_requirements' }) }));
            handoff.blocker = { tool: 'run_project_process', target: '.', code: 'TEST_UNAVAILABLE', message: 'Tests cannot run here', nextAction: 'Report limitation', at: Date.now() };
            const result: any = await input.execute('complete_project_requirements', {
              requirementIds: [state.requirements[0].id], note: 'Implemented the fix. Tests cannot run in this environment.',
            });
            expect(result.error).toBeUndefined();
          } else if (repair) {
            const result: any = await input.execute('run_project_process', {
              executable: 'node',
              args: ['--test'],
              purpose: 'test',
            });
            const status: any = await input.execute('update_project_task', {
              requirements: [{ ...handoff.requirements[0], status: 'passed', evidenceIds: [result.evidenceId] }],
              remaining: '',
            });
            expect(status.error).toBeUndefined();
          }
        }
        const text = 'Implemented the requested fix and checked the behavior.';
        input.onText?.(text);
        return { text };
      },
    } as ProjectAgentRuntime;
    await new ChatService(
      store,
      {} as ModelProvider,
      () => {},
      () => false,
      undefined,
      undefined,
      projects,
      runtime,
    ).send(chat.id, profile, 'Fix behavior');
    expect(runs).toBe(repair ? 2 : 3);
    expect(chat.status).toBe(repair ? 'idle' : 'failed');
    expect(chat.messages.at(-1)?.delivery?.status).toBe(repair ? 'completed' : 'blocked');
    expect(commitResponse).toHaveBeenCalledTimes(repair ? 1 : 0);
    if (mode === 'assessed') {
      expect(chat.messages.at(-1)?.verification).toBe('not_run');
      expect(handoff.requirements[0]).toMatchObject({ status: 'completed', evidenceIds: [] });
      expect(handoff.blocker?.code).toBe('TEST_UNAVAILABLE');
    }
    if (!repair) {
      expect(chat.messages.at(-1)?.content).toContain('Verification remains incomplete');
      expect(chat.messages.at(-1)?.content).toContain('Implemented the requested fix and checked the behavior.');
    }
    expect(chat.messages.at(-1)?.toolActivity?.filter((item) => item.name === 'patch_project_file')).toHaveLength(1);
  },
);

it('answers an inspection follow-up without completing historical failed requirements or committing them', async () => {
  const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 16000 };
  const handoff = newHandoff(undefined, 'Implement old feature');
  handoff.changedPaths = ['main.py']; handoff.generation = 2;
  handoff.requirements = [{ text: 'Old implementation tests', status: 'blocked', verification: 'command', evidenceIds: [] }];
  handoff.blocker = { tool: 'run_project_process', target: '.', code: 'OLD_FAILURE', message: 'Old dependency issue', nextAction: 'Install later', at: 1 };
  const chat = { id: 'chat', projectId: 'p', title: 'Task', profile, messages: [], status: 'idle', updatedAt: 1, projectHandoff: handoff } as ChatThread;
  const store = { settings: () => ({ connections: [{ id: 'fixture', provider: 'ollama', url: 'http://unused.invalid' }] }), chat: () => chat, project: () => ({ id: 'p', permissionMode: 2 }), saveChat: vi.fn() } as unknown as Store;
  const commitResponse = vi.fn();
  const projects = { prepare: async () => 'Project', loadWorkflows: async () => ({ context: '', loaded: [], warnings: [] }), generation: () => 0, commitResponse } as unknown as ProjectTools;
  const run = vi.fn(async input => { const text = 'The previous run failed because the environment was incompatible. No runtime absence was established.'; input.onText(text); return { text }; });
  await new ChatService(store, {} as ModelProvider, () => {}, () => false, undefined, undefined, projects, { run } as unknown as ProjectAgentRuntime).send(chat.id, profile, 'Read main.py and explain the previous failure');
  expect(run).toHaveBeenCalledTimes(1); expect(commitResponse).not.toHaveBeenCalled();
  expect(chat.status).toBe('idle'); expect(chat.messages.at(-1)?.delivery?.status).toBe('completed');
  expect(chat.messages.at(-1)?.verification).toBe('not_run');
  expect(chat.projectHandoff?.requirements[0].status).toBe('blocked');
  expect(chat.messages.at(-1)?.content).toContain('No runtime absence was established');
});
