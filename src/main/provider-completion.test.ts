import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders, type ChatInput } from './providers';

type Provider = 'ollama' | 'lmstudio';
const input = (provider: Provider): ChatInput => ({ profile: { provider, connectionId: 'fixture', model: 'test', contextLimit: 8192 }, messages: [{ role: 'user', content: 'Find the docs' }], signal: new AbortController().signal });
const service = (provider: Provider) => new LocalProviders(() => ({ connections: [{ id: 'fixture', provider, label: 'Fixture', url: 'http://127.0.0.1:1234' }], mainModel: null, plannerModel: null, subagentModel: null }));
const stream = (provider: Provider, chunks: object[], done = false) => new Response(chunks.map(chunk => (provider === 'ollama' ? '' : 'data: ') + JSON.stringify(chunk) + '\n').join('') + (done ? 'data: [DONE]\n' : ''));
afterEach(() => vi.unstubAllGlobals());

it.each<Provider>(['ollama', 'lmstudio'])('rejects %s EOF after partial text instead of reporting completion or replaying it', async provider => {
  const fetch = vi.fn().mockResolvedValue(stream(provider, [provider === 'ollama' ? { message: { content: 'Let me find the docs.' } } : { choices: [{ delta: { content: 'Let me find the docs.' } }] }]));
  vi.stubGlobal('fetch', fetch); const onText = vi.fn();
  await expect(service(provider).chat({ ...input(provider), onText })).rejects.toThrow('without a completion marker');
  expect(onText).toHaveBeenCalledWith('Let me find the docs.'); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each<Provider>(['ollama', 'lmstudio'])('does not return tool calls from a truncated %s stream', async provider => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(provider, [provider === 'ollama'
    ? { message: { tool_calls: [{ function: { name: 'create_file', arguments: { name: 'partial.txt', content: 'incomplete' } } }] } }
    : { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create_file', arguments: '{"name":"partial.txt","content":"incomplete"}' } }] } }] }])));
  await expect(service(provider).chat(input(provider))).rejects.toThrow('no tool actions');
});
it.each<Provider>(['ollama', 'lmstudio'])('accepts a normally terminated %s answer and preserves usage', async provider => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(provider, [provider === 'ollama'
    ? { message: { content: 'Verified answer' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 5 }
    : { choices: [{ delta: { content: 'Verified answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }])));
  expect(await service(provider).chat(input(provider))).toMatchObject({ text: 'Verified answer', tools: [], usage: { input: 12, output: 5 } });
});
it('accepts the LM Studio DONE marker even when finish_reason is omitted', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream('lmstudio', [{ choices: [{ delta: { content: 'Done' } }] }], true)));
  expect((await service('lmstudio').chat(input('lmstudio'))).text).toBe('Done');
});

it('sends the verified LM Studio fast-summary setting when thinking is disabled', async () => {
  const fetch = vi.fn().mockResolvedValue(stream('lmstudio', [{ choices: [{ delta: { content: 'Summary' }, finish_reason: 'stop' }] }]));
  vi.stubGlobal('fetch', fetch);
  await service('lmstudio').chat({ ...input('lmstudio'), disableThinking: true });
  expect(JSON.parse(fetch.mock.calls[0][1].body).reasoning).toEqual({ effort: 'none' });
});

it('uses the native LM Studio reasoning control for reports without enabling tools or stored sessions', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: [{ type: 'message', content: 'Architecture overview' }], stats: { total_output_tokens: 10 } })));
  vi.stubGlobal('fetch', fetch);
  const result = await service('lmstudio').chat({ ...input('lmstudio'), reportMode: true, maxOutputTokens: 100 });
  expect(fetch.mock.calls[0][0]).toContain('/api/v1/chat');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ reasoning: 'off', store: false, integrations: [] });
  expect(result.text).toBe('Architecture overview');
});
it.each<Provider>(['ollama', 'lmstudio'])('rejects %s output token exhaustion even with a terminal marker', async provider => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(provider, [provider === 'ollama'
    ? { message: { content: 'Cut off' }, done: true, done_reason: 'length' }
    : { choices: [{ delta: { content: 'Cut off' }, finish_reason: 'length' }] }], provider === 'lmstudio')));
  await expect(service(provider).chat(input(provider))).rejects.toThrow('before finishing');
});
it('rejects content-filter termination and malformed tool arguments without returning executable calls', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(stream('lmstudio', [{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }], true))
    .mockResolvedValueOnce(stream('lmstudio', [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'create_file', arguments: '{"name":' } }] }, finish_reason: 'tool_calls' }] }], true));
  vi.stubGlobal('fetch', fetch);
  await expect(service('lmstudio').chat(input('lmstudio'))).rejects.toThrow('content_filter');
  await expect(service('lmstudio').chat(input('lmstudio'))).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
