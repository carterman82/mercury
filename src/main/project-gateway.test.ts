import { afterEach, expect, it, vi } from 'vitest';
import type { ChatInput, ModelProvider } from './providers';
import { ProjectModelGateway, type ProjectGatewaySession } from './project-gateway';
import { ModelHttpError } from './vision';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'qwen-fixture', contextLimit: 32000 };
const sessions: ProjectGatewaySession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});
async function open(chat: ModelProvider['chat'], extra: Partial<Parameters<ProjectModelGateway['open']>[0]> = {}) {
  const session = await new ProjectModelGateway({ chat } as ModelProvider).open({
    projectId: 'project',
    chatId: 'chat',
    agentId: 'main',
    profile,
    ...extra,
  });
  sessions.push(session);
  return session;
}
function post(session: ProjectGatewaySession, body: object, headers: Record<string, string> = {}) {
  return fetch(session.baseUrl + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}`, ...headers },
    body: JSON.stringify({ model: session.model, messages: [{ role: 'user', content: 'Hello' }], ...body }),
  });
}
const events = (text: string): any[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));

it('binds credentials and model selection to one session with a scoped catalog', async () => {
  const chat = vi.fn(async () => ({ text: 'Hello', tools: [] }));
  const first = await open(chat),
    second = await open(chat);
  expect((await fetch(first.baseUrl + '/v1/models')).status).toBe(401);
  expect(
    (await fetch(first.baseUrl + '/v1/models', { headers: { authorization: `Bearer ${second.token}` } })).status,
  ).toBe(401);
  const catalog = (await (
    await fetch(first.baseUrl + '/v1/models', { headers: { 'x-api-key': first.token } })
  ).json()) as any;
  expect(catalog.data).toHaveLength(1);
  expect(catalog.data[0]).toMatchObject({ id: first.model, display_name: profile.model });
  expect((await post(first, { model: 'claude-other-paid-model' })).status).toBe(400);
  expect((await post(first, {}, { origin: 'https://untrusted.example' })).status).toBe(401);
  expect(chat).not.toHaveBeenCalled();
  expect(
    (
      await fetch(first.baseUrl + '/v1/messages/count_tokens', {
        method: 'POST',
        headers: { authorization: `Bearer ${first.token}` },
      })
    ).status,
  ).toBe(404);
});

it('pins helper aliases to the selected exact provider profile without substituting Claude', async () => {
  const selected = structuredClone(profile);
  const chat = vi.fn(async (input: ChatInput) => {
    expect(input.profile).toEqual(selected);
    return { text: 'From selected model', tools: [] };
  });
  const session = await open(chat, { aliases: ['sdk-helper'] });
  profile.contextLimit = 24000;
  try {
    const result = await post(session, { model: 'sdk-helper' });
    expect(result.status).toBe(200);
    // The route captured its own immutable profile before this settings change.
    expect(chat.mock.calls[0][0].profile.contextLimit).toBe(32000);
  } finally {
    profile.contextLimit = 32000;
  }
});

it('translates system text, exact tool IDs/results, images and documents without executing tools', async () => {
  const image = Buffer.from('fixture bytes').toString('base64');
  const chat = vi.fn(async (input: ChatInput) => {
    expect(input.messages).toEqual([
      { role: 'system', content: 'System instruction' },
      {
        role: 'assistant',
        content: 'Reading',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read_project_file', arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '[Tool returned an error]\nAccess denied' },
      {
        role: 'user',
        content: 'Inspect this',
        images: [{ mimeType: 'image/png', data: image }],
        documents: [{ name: 'Report', mimeType: 'application/pdf', data: image }],
      },
    ]);
    expect(input.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_project_file', description: 'Read source', parameters: { type: 'object' } },
      },
    ]);
    return { text: '', tools: [{ id: 'call-2', name: 'read_project_file', arguments: { path: 'b.ts' } }] };
  });
  const session = await open(chat);
  const result = (await (
    await post(session, {
      system: [{ type: 'text', text: 'System instruction' }],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading' },
            { type: 'tool_use', id: 'call-1', name: 'read_project_file', input: { path: 'a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'Access denied', is_error: true },
            { type: 'text', text: 'Inspect this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
            {
              type: 'document',
              title: 'Report',
              source: { type: 'base64', media_type: 'application/pdf', data: image },
            },
          ],
        },
      ],
      tools: [{ name: 'read_project_file', description: 'Read source', input_schema: { type: 'object' } }],
    })
  ).json()) as any;
  expect(result).toMatchObject({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'call-2', name: 'read_project_file', input: { path: 'b.ts' } }],
  });
  expect(chat).toHaveBeenCalledTimes(1);
});

it('does not reuse local adapter call IDs across SDK turns', async () => {
  const session = await open(async () => ({ text: '', tools: [{ id: 'call_0', name: 'read_source', arguments: {} }] }));
  const result = (await (
    await post(session, {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_0', name: 'read_source', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0', content: 'done' }] },
      ],
      tools: [{ name: 'read_source', input_schema: { type: 'object' } }],
    })
  ).json()) as any;
  expect(result.content[0].id).not.toBe('call_0');
  expect(result.content[0].name).toBe('read_source');
});

it('streams text exactly once, emits valid tool JSON and completion, and reports reasoning separately', async () => {
  const reasoning = vi.fn(),
    usage = vi.fn();
  const session = await open(
    async (input) => {
      input.onText?.('Hello ');
      input.onReasoning?.('Private progress');
      input.onText?.('world');
      return {
        text: 'Hello world!',
        reasoning: 'Private progress',
        tools: [{ id: 'tool-1', name: 'read_source', arguments: { path: 'index.ts' } }],
        usage: { input: 12, output: 5 },
      };
    },
    { onReasoning: reasoning, onUsage: usage },
  );
  const response = await post(session, {
    stream: true,
    tools: [{ name: 'read_source', input_schema: { type: 'object' } }],
  });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const text = await response.text(),
    values = events(text);
  expect(
    values
      .filter((item) => item.type === 'content_block_delta' && item.delta.type === 'text_delta')
      .map((item) => item.delta.text)
      .join(''),
  ).toBe('Hello world!');
  expect(
    values.find((item) => item.type === 'content_block_delta' && item.delta.type === 'input_json_delta').delta
      .partial_json,
  ).toBe('{"path":"index.ts"}');
  expect(values.at(-2)).toMatchObject({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { input_tokens: 12, output_tokens: 5 },
  });
  expect(values.at(-1)).toEqual({ type: 'message_stop' });
  expect(text).not.toContain('Private progress');
  expect(reasoning).toHaveBeenCalledWith('Private progress');
  expect(usage).toHaveBeenCalledWith({ input: 12, output: 5 });
});

it('rejects unsupported semantic blocks and required features instead of stripping them', async () => {
  const chat = vi.fn(async () => ({ text: 'Must not run', tools: [] }));
  const session = await open(chat);
  for (const body of [
    {
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Untranslatable', signature: 'signed' }] },
      ],
    },
    { output_config: { format: { type: 'json_schema', schema: {} } } },
    { context_management: { edits: [{}] } },
    {
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }] },
      ],
    },
  ])
    expect((await post(session, body)).status).toBe(400);
  expect(chat).not.toHaveBeenCalled();
});

it('does not expose fabricated tool calls when a provider ignores the offered tools', async () => {
  const session = await open(async () => ({
    text: '',
    tools: [{ id: 'invented', name: 'shell_escape', arguments: {} }],
  }));
  const response = await post(session, {});
  expect(response.status).toBe(502);
  expect(await response.text()).toContain('unoffered tool');
});

it('ends failed streams with an error and never emits successful completion or executable pending tools', async () => {
  const session = await open(async (input) => {
    input.onText?.('Partial');
    throw new ModelHttpError(429, 'Quota exhausted');
  });
  const response = await post(session, { stream: true });
  const values = events(await response.text());
  expect(values.some((item) => item.type === 'error')).toBe(true);
  expect(values.some((item) => item.type === 'message_stop')).toBe(false);
  expect(values.some((item) => item.content_block?.type === 'tool_use')).toBe(false);
});

it('preserves upstream error status without rerouting or retrying inference', async () => {
  const chat = vi.fn(async () => {
    throw new ModelHttpError(400, 'Malformed upstream request');
  });
  const session = await open(chat);
  const response = await post(session, {});
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('Malformed upstream');
  expect(chat).toHaveBeenCalledTimes(1);
});

it('cancels active provider work when the gateway closes and invalidates its credential', async () => {
  let active = false,
    cancelled = false;
  const session = await open(async (input) => {
    active = true;
    await new Promise<void>((_resolve, reject) =>
      input.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(input.signal.reason);
        },
        { once: true },
      ),
    );
    return { text: 'Must not finish', tools: [] };
  });
  const response = await post(session, { stream: true });
  const pending = response.text().catch(() => 'disconnected');
  await expect.poll(() => active).toBe(true);
  await session.close();
  await pending;
  await expect.poll(() => cancelled).toBe(true);
  await expect(post(session, {})).rejects.toThrow();
  await session.close();
});

it('cancels active work when the SDK disconnects without closing the other session', async () => {
  let cancelled = false;
  const first = await open(async (input) => {
    await new Promise<void>((_resolve, reject) =>
      input.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(input.signal.reason);
        },
        { once: true },
      ),
    );
    return { text: 'Not reached', tools: [] };
  });
  const response = await post(first, { stream: true });
  await response.body!.cancel();
  await expect.poll(() => cancelled).toBe(true);
  const second = await open(async () => ({ text: 'Independent', tools: [] }));
  expect((await post(second, {})).status).toBe(200);
});

it('passes native Messages streams and feature headers through the host credential boundary', async () => {
  const native = vi.fn(async (body: Record<string, unknown>, _signal: AbortSignal, headers: Record<string, string>) => {
    expect(body.model).toBe(profile.model);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(headers).toMatchObject({ 'anthropic-beta': 'fixture-beta', 'anthropic-version': '2023-06-01' });
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      headers: {
        'content-type': 'text/event-stream',
        'x-should-retry': 'false',
        'anthropic-ratelimit-requests-remaining': '9',
      },
    });
  });
  const chat = vi.fn();
  const session = await open(chat, { nativeMessages: native });
  const response = await post(
    session,
    { stream: true, thinking: { type: 'adaptive' } },
    { 'anthropic-beta': 'fixture-beta', 'anthropic-version': '2023-06-01' },
  );
  expect(response.headers.get('x-should-retry')).toBe('false');
  expect(response.headers.get('anthropic-ratelimit-requests-remaining')).toBe('9');
  expect(await response.text()).toContain('message_stop');
  expect(chat).not.toHaveBeenCalled();
});

it('uses translated fallback only when the host explicitly reports native Messages unavailable', async () => {
  const native = vi.fn(async () => null);
  const chat = vi.fn(async () => ({ text: 'Translated', tools: [] }));
  const session = await open(chat, { nativeMessages: native });
  expect(((await (await post(session, {})).json()) as any).content).toEqual([{ type: 'text', text: 'Translated' }]);
  expect(native).toHaveBeenCalledTimes(1);
  expect(chat).toHaveBeenCalledTimes(1);
});

it('drives the actual Agent SDK through a complete custom-tool round trip', async () => {
  const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-sdk-gateway-'));
  let requests = 0,
    executions = 0;
  const session = await open(async (input) => {
    requests++;
    if (requests === 1) {
      const inspect = (input.tools as any[]).find((item) => item.function.name.endsWith('__inspect'));
      if (!inspect) throw new Error('The SDK did not expose the fixture custom tool.');
      return {
        text: '',
        tools: [{ id: 'sdk-fixture-call', name: inspect.function.name, arguments: { filename: 'fixture.ts' } }],
      };
    }
    expect(JSON.stringify(input.messages)).toContain('Fixture source inspected');
    return { text: 'Actual SDK roundtrip complete.', tools: [] };
  });
  const inspector = tool('inspect', 'Inspect the named fixture source.', { filename: z.string() }, async (args) => {
    expect(args.filename).toBe('fixture.ts');
    executions++;
    return { content: [{ type: 'text', text: 'Fixture source inspected' }] };
  });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: directory,
    USERPROFILE: directory,
    CLAUDE_CONFIG_DIR: directory,
    ANTHROPIC_BASE_URL: session.baseUrl,
    ANTHROPIC_AUTH_TOKEN: session.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
    ENABLE_TOOL_SEARCH: 'false',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: session.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: session.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: session.model,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SDK fixture deadline exceeded.')), 20000);
  const response = query({
    prompt: 'Inspect fixture.ts, then report completion.',
    options: {
      cwd: directory,
      env: environment,
      model: session.model,
      tools: [],
      settingSources: [],
      permissionMode: 'default',
      allowedTools: ['mcp__gateway_fixture__inspect'],
      mcpServers: { gateway_fixture: createSdkMcpServer({ name: 'gateway_fixture', tools: [inspector] }) },
      persistSession: false,
      maxTurns: 4,
      abortController: controller,
    },
  });
  try {
    const messages = [];
    for await (const message of response) messages.push(message);
    expect(
      messages.some(
        (message: any) =>
          message.type === 'result' &&
          message.subtype === 'success' &&
          message.result.includes('Actual SDK roundtrip complete.'),
      ),
    ).toBe(true);
    expect(requests).toBe(2);
    expect(executions).toBe(1);
  } finally {
    clearTimeout(timer);
    response.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
