import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders, type ChatInput } from './providers';

const phrase = 'I should reconsider the same alternatives before deciding what to do next. ';
const request = (provider: 'ollama' | 'lmstudio'): ChatInput => ({
  profile: { provider, connectionId: 'local', model: 'qwen/qwen3-coder-next', contextLimit: 32768 },
  messages: [{ role: 'user', content: 'Fix the problem' }],
  signal: new AbortController().signal,
});
const service = (provider: 'ollama' | 'lmstudio') =>
  new LocalProviders(() => ({
    connections: [{ id: 'local', provider, label: 'Local', url: 'http://localhost:1234', maxConcurrentRequests: 1 }],
    mainModel: null,
    plannerModel: null,
    subagentModel: null,
  }));
const sse = (events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['ollama', 'lmstudio'] as const)(
  'prevents %s looping after a preamble and releases its request slot',
  async (provider) => {
    const events =
      provider === 'ollama'
        ? [{ message: { content: 'Checking. ' } }, { message: { thinking: phrase.repeat(100) } }, { done: true }]
        : [
            { choices: [{ delta: { content: 'Checking. ' } }] },
            { choices: [{ delta: { reasoning_content: phrase.repeat(100) } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          provider === 'ollama'
            ? new Response(events.map((event) => JSON.stringify(event) + '\n').join(''))
            : sse(events),
        ),
    );
    const model = service(provider);
    await expect(model.chat(request(provider))).rejects.toMatchObject({ kind: 'repetition' });
    expect(model.requestCounts).toEqual([]);
  },
);

it.each(['ollama', 'lmstudio'] as const)(
  'applies Qwen Coder Next sampling and finite output settings for %s without effort',
  async (provider) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        provider === 'ollama'
          ? new Response(JSON.stringify({ message: { content: 'Done' }, done: true }) + '\n')
          : sse([{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }]),
      );
    vi.stubGlobal('fetch', fetch);
    await service(provider).chat({ ...request(provider), disableThinking: true });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(provider === 'ollama' ? body.options : body).toMatchObject({
      temperature: 1,
      top_p: 0.95,
      top_k: 40,
      repeat_penalty: 1.1,
      [provider === 'ollama' ? 'num_predict' : 'max_tokens']: 8192,
    });
    if (provider === 'ollama') {
      expect(body).toHaveProperty('think', false);
    } else {
      expect(body).not.toHaveProperty('think');
      expect(body).toHaveProperty('reasoning', { effort: 'none' });
    }
  },
);

it('propagates native Messages repetition errors and cancels the upstream body', async () => {
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: phrase.repeat(100) } })}\n\n`,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes);
          },
          cancel,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    ),
  );
  const model = service('lmstudio');
  const response = await model.messages!({
    profile: request('lmstudio').profile,
    body: { messages: [], stream: true },
    signal: new AbortController().signal,
  });
  await expect(response!.text()).rejects.toMatchObject({ kind: 'repetition' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.requestCounts).toEqual([]);
});

it('caps reasoning and output even when the server ignores its token limit', async () => {
  for (const [field, count, kind] of [
    ['reasoning_content', 31000, 'budget'],
    ['content', 128001, 'output'],
  ] as const) {
    // Unique words avoid mistaking a budget check for repetition detection.
    const text = Array.from({ length: count }, (_, i) => String.fromCharCode(0x400 + (i % 200))).join('');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { [field]: text }, finish_reason: 'stop' }] }])),
    );
    await expect(service('lmstudio').chat(request('lmstudio'))).rejects.toMatchObject({ kind });
  }
});

it('never returns an incomplete oversized tool call even if answer text has already started', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        sse([
          { choices: [{ delta: { content: 'Preparing the edit.' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { name: 'edit_project_file', arguments: 'x'.repeat(128001) } }],
                },
              },
            ],
          },
        ]),
      ),
  );
  const model = service('lmstudio');
  await expect(model.chat(request('lmstudio'))).rejects.toMatchObject({ kind: 'output' });
  expect(model.requestCounts).toEqual([]);
});

it('allows repetitive fenced code while keeping its hard output budget', async () => {
  const text = '```text\n' + phrase.repeat(100) + '\n```\nDone';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }])),
  );
  await expect(service('lmstudio').chat(request('lmstudio'))).resolves.toMatchObject({ text });
});

it('does not mistake a literal fence with an info string inside code for the closing fence', async () => {
  const text = '```text\n```javascript\n' + phrase.repeat(100) + '\n```\nDone';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }])),
  );
  await expect(service('lmstudio').chat(request('lmstudio'))).resolves.toMatchObject({ text });
});

it.each(['ollama', 'lmstudio'] as const)(
  'detects fragmented think blocks and repeated answer prose for %s',
  async (provider) => {
    for (const pieces of [
      ['<thi', 'nk>', ...Array(100).fill(phrase), '</think>'],
      ['Checking. ', ...Array(100).fill(phrase)],
    ]) {
      const events = pieces.map((content) =>
        provider === 'ollama' ? { message: { content } } : { choices: [{ delta: { content } }] },
      );
      const cancel = vi.fn();
      const bytes = new TextEncoder().encode(
        events.map((event) => (provider === 'ollama' ? '' : 'data: ') + JSON.stringify(event) + '\n').join(''),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes);
              },
              cancel,
            }),
          ),
        ),
      );
      const model = service(provider);
      await expect(model.chat(request(provider))).rejects.toMatchObject({ kind: 'repetition' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(model.requestCounts).toEqual([]);
    }
  },
);

it('bounds unique progressing generation time', async () => {
  vi.useFakeTimers();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              upstream = c;
            },
            cancel,
          }),
        ),
    ),
  );
  const model = service('lmstudio');
  const first = model.chat(request('lmstudio'));
  const check = expect(first).rejects.toMatchObject({ kind: 'duration' });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 6; i++) {
    upstream.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Fresh observation ${i}. ` } }] })}\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(100_000);
  }
  await check;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.requestCounts).toEqual([]);
});

it('does not spend a queued native request generation allowance while its predecessor runs', async () => {
  vi.useFakeTimers();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.fn().mockImplementation(async () =>
    fetch.mock.calls.length === 1
      ? new Response(
          new ReadableStream({
            start(c) {
              upstream = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      : sse([{ type: 'message_stop' }]),
  );
  vi.stubGlobal('fetch', fetch);
  const model = service('lmstudio');
  const native = { profile: request('lmstudio').profile, body: { stream: true }, signal: new AbortController().signal };
  const first = await model.messages(native);
  const reading = expect(first!.text()).rejects.toMatchObject({ kind: 'duration' });
  const next = model.messages(native);
  await vi.advanceTimersByTimeAsync(0);
  expect(model.requestCounts[0].queued).toBe(1);
  for (let i = 0; i < 6; i++) {
    upstream.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: `Fresh observation ${i}. ` } })}\n\n`,
      ),
    );
    await vi.advanceTimersByTimeAsync(100_000);
  }
  await reading;
  const second = await next;
  expect(await second!.text()).toContain('message_stop');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(model.requestCounts).toEqual([]);
});

it.each([false, true])('does not wait for an uncooperative stream cancellation (native=%s)', async (native) => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }),
      ),
  );
  const model = service('lmstudio');
  const pending = native
    ? (await model.messages({
        profile: request('lmstudio').profile,
        body: { stream: true },
        signal: new AbortController().signal,
      }))!.text()
    : model.chat(request('lmstudio'));
  const check = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  await vi.advanceTimersByTimeAsync(120_001);
  await check;
  expect(model.requestCounts).toEqual([]);
});

it('returns promptly when the caller cancels a native body whose upstream cancellation stalls', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }))),
  );
  const model = service('lmstudio');
  const response = await model.messages({
    profile: request('lmstudio').profile,
    body: { stream: true },
    signal: new AbortController().signal,
  });
  const done = vi.fn();
  void response!.body!.cancel('Stop').then(done);
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalledTimes(1);
  expect(model.requestCounts).toEqual([]);
});

it('preserves native structured-output settings and applies the default Ollama checkpoint tag policy', async () => {
  const fetch = vi.fn().mockResolvedValue(sse([{ type: 'message_stop' }]));
  vi.stubGlobal('fetch', fetch);
  const response = await service('lmstudio').messages({
    profile: { ...request('lmstudio').profile, model: 'qwen3-coder-next:latest' },
    body: {
      stream: true,
      output_config: { effort: 'high', format: { type: 'json_schema' } },
      thinking: { type: 'adaptive' },
    },
    signal: new AbortController().signal,
  });
  await response!.text();
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body).toMatchObject({
    temperature: 1,
    top_p: 0.95,
    top_k: 40,
    max_tokens: 8192,
    output_config: { format: { type: 'json_schema' } },
  });
  expect(body.output_config).not.toHaveProperty('effort');
  expect(body).not.toHaveProperty('thinking');
});

it('keeps native thinking budgets below the clamped output allowance for other models', async () => {
  const fetch = vi.fn().mockResolvedValue(sse([{ type: 'message_stop' }]));
  vi.stubGlobal('fetch', fetch);
  const response = await service('lmstudio').messages({
    profile: { ...request('lmstudio').profile, model: 'another-thinking-model' },
    body: { stream: true, max_tokens: 32000, thinking: { type: 'enabled', budget_tokens: 16000 } },
    signal: new AbortController().signal,
  });
  await response!.text();
  const body = JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.max_tokens).toBe(8192);
  expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  // Sampling params are always sent now
  expect(body.temperature).toBe(1);
  expect(body.top_p).toBe(0.95);
  expect(body.top_k).toBe(40);
});

it('also rejects repetitive nonstreaming native Messages content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'thinking', thinking: phrase.repeat(100) }] })),
  );
  const model = service('lmstudio');
  const response = await model.messages({
    profile: request('lmstudio').profile,
    body: { stream: false },
    signal: new AbortController().signal,
  });
  await expect(response!.text()).rejects.toMatchObject({ kind: 'repetition' });
  expect(model.requestCounts).toEqual([]);
});

it('aborts a native pending read with a typed inactivity error instead of successful EOF', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }),
      ),
  );
  const model = service('lmstudio');
  const response = await model.messages!({
    profile: request('lmstudio').profile,
    body: { stream: true },
    signal: new AbortController().signal,
  });
  const reading = expect(response!.text()).rejects.toMatchObject({ kind: 'timeout' });
  await vi.advanceTimersByTimeAsync(120_001);
  await reading;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.requestCounts).toEqual([]);
});
