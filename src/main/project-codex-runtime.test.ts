import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexService } from './codex';
import { CodexProjectRuntime, ProjectRuntimeRouter } from './project-codex-runtime';
import type { ProjectAgentInput } from './project-agent-runtime';

function fixture(options: { unknown?: boolean; native?: boolean; wait?: boolean } = {}) {
  const requests: any[] = [];
  let interrupt = () => {};
  const launch = async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const emit = (value: unknown) => queueMicrotask(() => child.stdout.write(JSON.stringify(value) + '\n'));
    const notify = (method: string, params: any) => emit({ method, params: { threadId: 'thread', ...params } });
    interrupt = () => notify('item/started', { item: { type: 'commandExecution' } });
    child.stdin.on('data', (bytes) => {
      for (const line of bytes.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        requests.push(message);
        if (message.id === 'server-call') {
          notify('item/agentMessage/delta', { delta: 'Verified change' });
          notify('turn/completed', { turn: { status: 'completed' } });
        } else if (message.method === 'thread/start' || message.method === 'thread/resume')
          emit({ id: message.id, result: { thread: { id: 'thread' } } });
        else if (message.method === 'turn/start') {
          emit({ id: message.id, result: { turn: { id: 'turn' } } });
          if (options.wait) continue;
          if (options.native) notify('item/started', { item: { type: 'commandExecution' } });
          else
            emit({
              id: 'server-call',
              method: 'item/tool/call',
              params: {
                threadId: 'thread',
                turnId: 'turn',
                callId: 'call',
                tool: options.unknown ? 'unoffered' : 'read_project_file',
                arguments: { path: 'src/a.ts' },
              },
            });
        } else if (message.method && message.id !== undefined) emit({ id: message.id, result: {} });
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const service = new CodexService('C:/test/mercury-native-profile', async () => {}, launch);
  const runtime = new CodexProjectRuntime(service);
  const input: ProjectAgentInput = {
    projectId: randomUUID(),
    chatId: randomUUID(),
    workspaceRoot: 'C:/test/project',
    profile: { provider: 'codex', connectionId: 'codex-account', model: 'selected-model', contextLimit: 8192 },
    messages: [{ role: 'user', content: 'Fix and test' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_project_file',
          description: 'Read source',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ],
    signal: new AbortController().signal,
    execute: vi.fn(async () => ({ content: 'source', revision: 'abc' })),
    policyIdentity: 1,
  };
  return { runtime, requests, input, interrupt: () => interrupt() };
}

it('streams native text, executes registered tools through the host, and resumes persistent threads', async () => {
  const f = fixture();
  const onText = vi.fn();
  const first = await f.runtime.run({ ...f.input, onText });
  expect(first.text).toBe('Verified change');
  expect(onText).toHaveBeenCalledWith('Verified change');
  expect(f.input.execute).toHaveBeenCalledWith(
    'read_project_file',
    { path: 'src/a.ts' },
    expect.objectContaining({ id: expect.any(String) }),
  );
  expect(f.requests.find((request) => request.method === 'thread/start').params).toMatchObject({
    ephemeral: false,
    sandbox: 'read-only',
    dynamicTools: [{ type: 'function', name: 'read_project_file' }],
  });
  expect(f.requests.find((request) => request.id === 'server-call').result).toMatchObject({
    success: true,
    contentItems: [{ type: 'inputText' }],
  });
  await f.runtime.run({ ...f.input, session: first.session, messages: [{ role: 'user', content: 'Continue' }] });
  expect(f.requests.some((request) => request.method === 'thread/resume')).toBe(true);
});

it('invalidates resumed sessions when permissions change', async () => {
  const f = fixture();
  const first = await f.runtime.run(f.input);
  await f.runtime.run({ ...f.input, session: first.session, policyIdentity: 2 });
  expect(f.requests.filter((request) => request.method === 'thread/start')).toHaveLength(2);
});

it('returns failed tool results without executing unknown tools', async () => {
  const f = fixture({ unknown: true });
  await f.runtime.run(f.input);
  expect(f.input.execute).not.toHaveBeenCalled();
  expect(f.requests.find((request) => request.id === 'server-call').result.success).toBe(false);
});

it('rejects native actions and cancellation without rerouting to another provider', async () => {
  const f = fixture({ native: true });
  await expect(f.runtime.run(f.input)).rejects.toThrow('unregistered native tool');
  const waiting = fixture({ wait: true });
  const controller = new AbortController();
  const run = waiting.runtime.run({ ...waiting.input, signal: controller.signal });
  await vi.waitFor(() => expect(waiting.requests.some((request) => request.method === 'turn/start')).toBe(true));
  controller.abort(new Error('User stopped'));
  await expect(run).rejects.toThrow('User stopped');
});

it('uses native runtime only for explicitly selected Codex when the pilot is enabled', async () => {
  const f = fixture();
  const fallback = { run: vi.fn(), shutdown: vi.fn() };
  const native = { run: vi.fn(), shutdown: vi.fn() };
  new ProjectRuntimeRouter(fallback, native, false).run(f.input);
  expect(fallback.run).toHaveBeenCalled();
  new ProjectRuntimeRouter(fallback, native, true).run(f.input);
  expect(native.run).toHaveBeenCalled();
});

it('waits for an in-flight host action before reporting a protocol failure', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false,
    finished = false;
  const execute = async () => {
    started = true;
    await gate;
    return { content: 'done' };
  };
  const run = f.runtime.run({ ...f.input, execute }).catch((error) => {
    finished = true;
    return error;
  });
  await vi.waitFor(() => expect(started).toBe(true));
  f.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  release();
  expect(await run).toBeInstanceOf(Error);
  expect(finished).toBe(true);
});
