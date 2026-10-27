import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders, type ChatInput } from './providers';
import type { ModelConnection, ModelProfile, Settings } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());
function fixture(kind: 'claude' | 'ollama' | 'lmstudio' | 'openai' = 'ollama') {
  const connection: ModelConnection = {
    id: 'fixture',
    provider: kind,
    label: 'Fixture',
    url:
      kind === 'claude'
        ? 'https://api.anthropic.com'
        : kind === 'openai'
          ? 'https://api.openai.com'
          : 'http://127.0.0.1:11434',
    maxConcurrentRequests: 1,
  };
  const profile: ModelProfile = {
    provider: kind,
    connectionId: connection.id,
    model: 'exact-model',
    contextLimit: 32000,
  };
  const settings: Settings = { connections: [connection], mainModel: profile, plannerModel: null, subagentModel: null };
  const token = vi.fn(() => 'host-secret');
  const provider = new LocalProviders(() => settings, token);
  const input = {
    profile,
    body: { model: 'sdk-alias', messages: [{ role: 'user', content: 'Hello' }], stream: true, max_tokens: 512 },
    signal: new AbortController().signal,
  };
  return { provider, profile, input, token };
}
const stop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

it('forwards Claude Messages features while keeping the real credential in Mercury', async () => {
  const { provider, input, token } = fixture('claude');
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(stop, { headers: { 'content-type': 'text/event-stream' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const response = await provider.messages({
    ...input,
    body: { ...input.body, thinking: { type: 'adaptive' }, context_management: { edits: [] } },
    headers: {
      authorization: 'Bearer sdk-token',
      'x-api-key': 'sdk-token',
      'anthropic-beta': 'sdk-feature',
      'anthropic-version': '2023-06-01',
    },
  });
  expect(await response!.text()).toBe(stop);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.anthropic.com/v1/messages');
  expect(init!.headers).toMatchObject({ 'x-api-key': 'host-secret', 'anthropic-beta': 'sdk-feature' });
  expect((init!.headers as any).authorization).toBeUndefined();
  expect(token).toHaveBeenCalledWith('fixture');
  expect(JSON.parse(init!.body as string)).toMatchObject({
    model: 'exact-model',
    thinking: { type: 'adaptive' },
    context_management: { edits: [] },
  });
  expect(provider.requestCounts).toEqual([]);
});

it('keeps the native response slot until its body is consumed, then starts the queued request', async () => {
  const { provider, input } = fixture();
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> =>
    fetch.mock.calls.length === 1
      ? new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      : new Response(stop),
  );
  vi.stubGlobal('fetch', fetch);
  const first = await provider.messages(input);
  const queued = vi.fn();
  const second = provider.messages({ ...input, onRequestState: queued });
  await expect.poll(() => provider.requestCounts[0]?.queued).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(queued).toHaveBeenCalledWith('queued');
  const firstText = first!.text();
  upstream!.enqueue(new TextEncoder().encode(stop));
  upstream!.close();
  await firstText;
  const secondResponse = await second;
  expect(await secondResponse!.text()).toBe(stop);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(provider.requestCounts).toEqual([]);
});

it('releases native leases on body cancellation and parent abort', async () => {
  const { provider, input } = fixture();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
            },
          }),
        ),
    ),
  );
  const first = await provider.messages(input);
  expect(provider.requestCounts[0].active).toBe(1);
  await first!.body!.cancel('SDK stopped');
  expect(provider.requestCounts).toEqual([]);
  const controller = new AbortController();
  const second = await provider.messages({ ...input, signal: controller.signal });
  controller.abort(new Error('Project downgraded'));
  await expect.poll(() => provider.requestCounts.length).toBe(0);
  await second!.body!.cancel().catch(() => {});
});

it('falls back only on missing local Messages endpoints and preserves other status errors', async () => {
  const { provider, input } = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('Missing route', { status: 404 }))
    .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  expect(await provider.messages(input)).toBeNull();
  expect(provider.requestCounts).toEqual([]);
  const unauthorized = await provider.messages(input);
  expect(unauthorized!.status).toBe(401);
  expect(await unauthorized!.text()).toBe('Unauthorized');
  expect(provider.requestCounts).toEqual([]);
});

it('does not bypass OpenAI subscription routing with a direct native Messages request', async () => {
  const { provider, input, token } = fixture('openai');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await provider.messages(input)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(token).not.toHaveBeenCalled();
});

it.each(['ollama', 'lmstudio', 'claude', 'openai'] as const)(
  'carries SDK output limits and supported tool choice to %s',
  async (kind) => {
    const { provider, profile } = fixture(kind);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      kind === 'ollama'
        ? new Response(JSON.stringify({ message: { content: 'Done' }, done: true }) + '\n')
        : kind === 'lmstudio'
          ? new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          : kind === 'claude'
            ? new Response('data: {"type":"message_stop"}\n\n')
            : new Response('data: {"type":"response.completed"}\n\n'),
    );
    vi.stubGlobal('fetch', fetch);
    await provider.chat({
      profile,
      messages: [{ role: 'user', content: 'Hello' }],
      signal: new AbortController().signal,
      maxOutputTokens: 200,
      toolChoice: { type: 'tool', name: 'inspect', disable_parallel_tool_use: true },
      tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }],
    } satisfies ChatInput);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    if (kind === 'ollama') expect(body.options.num_predict).toBe(200);
    else if (kind === 'lmstudio')
      expect(body).toMatchObject({
        max_tokens: 200,
        tool_choice: { type: 'function', function: { name: 'inspect' } },
        parallel_tool_calls: false,
      });
    else if (kind === 'claude')
      expect(body).toMatchObject({
        max_tokens: 200,
        tool_choice: { type: 'tool', name: 'inspect', disable_parallel_tool_use: true },
      });
    else
      expect(body).toMatchObject({
        max_output_tokens: 200,
        tool_choice: { type: 'function', name: 'inspect' },
        parallel_tool_calls: false,
      });
  },
);
