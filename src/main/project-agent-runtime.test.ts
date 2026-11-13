import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ChatInput, ModelProvider } from './providers';
import { ClaudeProjectRuntime, type ProjectAgentInput } from './project-agent-runtime';
import { ProjectContextRollover } from './project-context-rollover';
import { ThinkingLimitError } from './thinking-guard';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const profile = {
  provider: 'ollama' as const,
  connectionId: 'fixture',
  model: 'test-local-model',
  contextLimit: 16000,
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-sdk-'));
  directories.push(root);
  const workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  return { root, workspace };
}

it('aborts actual SDK inference on a typed generation failure without transport retries', async () => {
  const { root, workspace } = await fixture();
  let requests = 0;
  const failure = new ThinkingLimitError('repetition');
  const runtime = new ClaudeProjectRuntime({ chat: async () => { requests++; throw failure; } } as unknown as ModelProvider, path.join(root, 'sessions'));
  try {
    await expect(runtime.run({ projectId: randomUUID(), chatId: randomUUID(), workspaceRoot: workspace, profile,
      messages: [{ role: 'user', content: 'Inspect this source' }], tools: [], execute: async () => ({}), signal: new AbortController().signal,
    })).rejects.toBe(failure);
    expect(requests).toBe(1);
  } finally { await runtime.shutdown(); }
}, 30000);

it('checkpoints an exhausted SDK turn budget instead of reporting a provider failure', async () => {
  const { root, workspace } = await fixture();
  const runtime = new ClaudeProjectRuntime({} as ModelProvider, path.join(root, 'sessions'), {
    loadSdk: async () => ({
      tool: () => ({}),
      createSdkMcpServer: () => ({ instance: { server: { setRequestHandler() {} } } }),
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Maximum turns reached'], session_id: 'budget-session' };
        },
        close() {},
      }),
    }) as any,
  });
  await expect(runtime.run({ projectId: randomUUID(), chatId: randomUUID(), workspaceRoot: workspace, profile,
    messages: [{ role: 'user', content: 'Continue all game descriptions' }], tools: [],
    execute: async () => ({}), signal: new AbortController().signal,
  })).rejects.toMatchObject({ reason: 'turns' });
  await runtime.shutdown();
});

it('runs the real pinned SDK through Mercury inference and executes only registered host tools', async () => {
  const { root, workspace } = await fixture();
  const seen: ChatInput[] = [];
  let executed = 0;
  const provider = {
    chat: async (input: ChatInput) => {
      seen.push(input);
      if (JSON.stringify(input.messages).includes('COMPACTED CHECKPOINT')) {
        return { text: 'Continued from the checkpoint without replaying the tool.', tools: [] };
      }
      expect(input.profile.model).toBe(profile.model);
      const toolResults = input.messages.filter((message: any) => message.role === 'tool');
      if (toolResults.length < 2) {
        const tools = input.tools as any[];
        expect(tools.some((tool) => tool.function.name === 'Bash')).toBe(false);
        expect(tools.some((tool) => tool.function.name === 'mcp__mercury__read_fixture')).toBe(true);
        return {
          text: '',
          tools: [{ id: 'tool_read_1', name: 'mcp__mercury__read_fixture', arguments: { path: 'note.txt' } }],
        };
      }
      const text = 'Verified fixture content through the local model.';
      input.onText?.(text);
      return { text, tools: [] };
    },
  } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(root, 'sessions'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  const text: string[] = [];
  const sessions: any[] = [];
  const input: ProjectAgentInput = {
    projectId: randomUUID(),
    chatId: randomUUID(),
    workspaceRoot: workspace,
    profile,
    messages: [
      { role: 'system', content: 'You are Mercury. Read the fixture using the offered tool, then answer.' },
      { role: 'user', content: 'Read note.txt.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_fixture',
          description: 'Read a test file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ],
    execute: async (name, args) => {
      expect(name).toBe('read_fixture');
      expect(args).toEqual({ path: 'note.txt' });
      executed++;
      return { content: 'fixture content' };
    },
    signal: new AbortController().signal,
    onText: (delta) => text.push(delta),
    onSession: (session) => sessions.push(session),
  };
  const result = await runtime.run(input);
  expect(result.text).toBe('Verified fixture content through the local model.');
  expect(text.join('')).toBe(result.text);
  expect(executed).toBe(2);
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(result.session.status).toBe('completed');
  expect(result.session.sessionId).toBeTruthy();
  expect(sessions.at(-1)).toMatchObject({ runtime: 'claude-agent-sdk', version: '0.3.310' });
  const resumed = await runtime.run({
    ...input,
    context: 'Updated project note: the fixture is verified. Preserve the previous tool results.',
    session: result.session,
    messages: [
      input.messages[0],
      { role: 'user', content: 'Summarize the saved results without calling tools again.' },
    ],
  });
  expect(resumed.session.sessionId).toBe(result.session.sessionId);
  expect(executed).toBe(2);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain('Updated project note');
  const compacted = await runtime.run({
    ...input,
    session: undefined,
    context: 'COMPACTED CHECKPOINT: the read tool already completed. Do not replay it.',
    messages: [
      input.messages[0],
      { role: 'user', content: 'Keep the original endpoint. Continue from the checkpoint.' },
    ],
  });
  expect(compacted.session.sessionId).not.toBe(resumed.session.sessionId);
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain('COMPACTED CHECKPOINT');
  expect(JSON.stringify(seen.at(-1)?.messages)).toContain('Keep the original endpoint');
  expect(JSON.stringify(seen.at(-1)?.messages)).not.toContain('fixture content');
  expect(executed).toBe(2);
}, 60000);

it('continues the real SDK with textual historical tools while keeping the latest exchange executable', async () => {
  const { root, workspace } = await fixture();
  let calls = 0,
    executed = 0,
    summarized = false;
  const provider = {
    chat: async (input: ChatInput) => {
      calls++;
      summarized ||= JSON.stringify(input.messages).includes('[Historical tool result:');
      if (calls > 1) {
        const latest: any = input.messages.filter((message: any) => message.role === 'tool').at(-1);
        expect(JSON.parse(latest.content).evidenceId).toBe(`saved-${calls - 1}`);
      }
      return calls <= 5
        ? {
            text: '',
            tools: [
              { id: `read-${calls}`, name: 'mcp__mercury__read_fixture', arguments: { path: `note-${calls}.txt` } },
            ],
          }
        : { text: 'Finished from saved historical evidence.', tools: [] };
    },
  } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(root, 'sessions'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  try {
    const result = await runtime.run({
      projectId: randomUUID(),
      chatId: randomUUID(),
      workspaceRoot: workspace,
      profile,
      messages: [{ role: 'user', content: 'Read the five fixtures once, then summarize.' }],
      signal: new AbortController().signal,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_fixture',
            description: 'Read a fixture',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
      ],
      execute: async (_name, args) => {
        executed++;
        expect(args).toEqual({ path: `note-${executed}.txt` });
        return { evidenceId: `saved-${executed}`, content: 'Fixture text. '.repeat(1100) };
      },
    });
    expect(result.text).toBe('Finished from saved historical evidence.');
    expect(summarized).toBe(true);
    expect(executed).toBe(5);
    expect(calls).toBe(6);
  } finally {
    await runtime.shutdown();
  }
}, 60000);

it('pauses the real SDK at the next inference boundary after the completed tool, preserving the rollover reason', async () => {
  const { root, workspace } = await fixture();
  let calls = 0,
    effects = 0,
    tokens = 0;
  const runtime = new ClaudeProjectRuntime(
    {
      chat: async () => {
        calls++;
        return {
          text: '',
          tools: [{ id: 'effect', name: 'mcp__mercury__write_fixture', arguments: {} }],
          usage: { input: 14400, output: 1 },
        };
      },
    } as unknown as ModelProvider,
    path.join(root, 'sessions'),
    {
      executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
    },
  );
  const signal = new AbortController().signal;
  try {
    await expect(
      runtime.run({
        projectId: randomUUID(),
        chatId: randomUUID(),
        workspaceRoot: workspace,
        profile,
        messages: [{ role: 'user', content: 'Write the fixture once.' }],
        signal,
        tools: [
          {
            type: 'function',
            function: {
              name: 'write_fixture',
              description: 'Write fixture',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
        ],
        execute: async () => {
          effects++;
          return { saved: true };
        },
        onUsage: (usage) => {
          tokens = usage?.input ?? 0;
        },
        onContextCheckpoint: () => {
          if (tokens >= 14400) throw new ProjectContextRollover();
        },
      }),
    ).rejects.toBeInstanceOf(ProjectContextRollover);
    expect(calls).toBe(1);
    expect(effects).toBe(1);
    expect(signal.aborted).toBe(false);
  } finally {
    await runtime.shutdown();
  }
}, 60000);

it('cancels a real SDK session and releases the model request', async () => {
  const { root, workspace } = await fixture();
  const controller = new AbortController();
  let entered = false;
  const provider = {
    chat: async (input: ChatInput) => {
      entered = true;
      await new Promise((_resolve, reject) =>
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }),
      );
      return { text: 'Never complete', tools: [] };
    },
  } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(root, 'sessions'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  const pending = runtime.run({
    projectId: randomUUID(),
    chatId: randomUUID(),
    workspaceRoot: workspace,
    profile,
    messages: [{ role: 'user', content: 'Wait for cancellation.' }],
    tools: [],
    execute: async () => ({}),
    signal: controller.signal,
  });
  const check = expect(pending).rejects.toThrow();
  await expect.poll(() => entered, { timeout: 30000 }).toBe(true);
  controller.abort(new Error('Stopped by test.'));
  await check;
  await runtime.shutdown();
}, 60000);
