import { expect, it, vi } from 'vitest';
import { ChatService } from './chat';
import { newHandoff } from './project-handoff';
import type { ChatThread } from '../shared/types';
import type { Store } from './store';
import type { ModelProvider } from './providers';
import type { ProjectTools } from './project-tools';
import type { ProjectAgentRuntime } from './project-agent-runtime';

it.each([true, false])(
  'continues a premature final to test and close criteria, with bounded retries (repair=%s)',
  async (repair) => {
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
        if (++runs === 1)
          await input.execute('patch_project_file', { path: 'app.ts', oldText: 'old', newText: 'fixed' });
        else {
          expect(input.messages.at(-1)?.content).toContain('Delivery is not yet verified');
          if (repair) {
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
    if (!repair) {
      expect(chat.messages.at(-1)?.content).toContain('Work saved; not complete');
      expect(chat.messages.at(-1)?.content).not.toContain('Implemented the requested fix and checked the behavior.');
    }
    expect(chat.messages.at(-1)?.toolActivity?.filter((item) => item.name === 'patch_project_file')).toHaveLength(1);
  },
);
