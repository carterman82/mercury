import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ChatInput, ModelProvider } from './providers';
import { ClaudeProjectRuntime, type ProjectAgentInput } from './project-agent-runtime';

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

it('runs the real pinned SDK through Mercury inference and executes only registered host tools', async () => {
  const { root, workspace } = await fixture();
  const seen: ChatInput[] = [];
  let executed = 0;
  const provider = {
    chat: async (input: ChatInput) => {
      seen.push(input);
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
    session: result.session,
    messages: [
      input.messages[0],
      { role: 'user', content: 'Summarize the saved results without calling tools again.' },
    ],
  });
  expect(resumed.session.sessionId).toBe(result.session.sessionId);
  expect(executed).toBe(2);
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
