import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudChat, cloudDiscover, cloudEndpoint, claudeInput, responsesInput } from './cloud-providers';
import { LocalProviders } from './providers';
import type { ModelConnection, ModelProfile } from '../shared/types';

const openai: ModelConnection = { id: 'chatgpt-test', provider: 'openai', label: 'ChatGPT', url: 'https://api.openai.com', auth: 'chatgpt' };
const claude: ModelConnection = { id: 'claude-test', provider: 'claude', label: 'Claude', url: 'https://api.anthropic.com' };
const profile = (connection = openai): ModelProfile => ({ provider: connection.provider, connectionId: connection.id, model: 'account-model', contextLimit: 8192 });
const stream = (events: any[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe('cloud model providers', () => {
  it('uses the ChatGPT account catalog and preserves server model names', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ slug: 'astra-account-slug', display_name: 'Astra', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] })));
    vi.stubGlobal('fetch', fetch);
    expect(await cloudDiscover(openai, 'oauth-secret')).toEqual([expect.objectContaining({ id: 'astra-account-slug', label: 'Astra', available: true })]);
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer oauth-secret');
  });

  it('paginates Claude models and authenticates with the API key', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }))).mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'second' }], has_more: false })));
    vi.stubGlobal('fetch', fetch);
    expect((await cloudDiscover(claude, 'api-secret')).map(item => item.id)).toEqual(['first', 'second']);
    expect(fetch.mock.calls[1][0]).toContain('after_id=first');
    expect(fetch.mock.calls[0][1].headers['x-api-key']).toBe('api-secret');
  });

  it('converts conversation and tool history for both APIs', () => {
    const messages = [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Read file' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'contents' }, { role: 'user', content: 'Continue' }];
    expect(responsesInput(messages)).toContainEqual({ type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' });
    expect(responsesInput(messages)).toContainEqual({ type: 'function_call_output', call_id: 'call-1', output: 'contents' });
    const converted = claudeInput(messages);
    expect(converted.system).toBe('Instructions');
    expect(converted.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } });
    expect(converted.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call-1', content: 'contents' }, { type: 'text', text: 'Continue' }]);
  });

  it('streams Responses output and tool calls through completion', async () => {
    const fetch = vi.fn().mockResolvedValue(stream([
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-1', name: 'read' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]));
    vi.stubGlobal('fetch', fetch);
    const onText = vi.fn();
    const result = await cloudChat(openai, 'token', { profile: profile(), messages: [{ role: 'user', content: 'Hi' }], signal: new AbortController().signal, onText });
    expect(result).toEqual({ text: 'Hello', tools: [{ id: 'call-1', name: 'read', arguments: { path: 'a' } }], usage: { input: 10, output: 5 } });
    expect(onText).toHaveBeenCalledWith('Hello');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ store: false, stream: true });
  });

  it('streams Claude reasoning, text, and partial tool JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Thinking' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'c1', name: 'read' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
      { type: 'message_stop' },
    ])));
    const result = await cloudChat(claude, 'token', { profile: profile(claude), messages: [], signal: new AbortController().signal });
    expect(result).toMatchObject({ text: 'Answer', reasoning: 'Thinking', tools: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] });
  });

  it('rejects truncated streams and late subscription limit failures', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stream([{ type: 'response.output_text.delta', delta: 'Partial' }])).mockResolvedValueOnce(stream([{ type: 'response.failed', response: { error: { message: 'Plan usage limit reached' } } }]));
    vi.stubGlobal('fetch', fetch);
    const input = { profile: profile(), messages: [], signal: new AbortController().signal };
    await expect(cloudChat(openai, 'token', input)).rejects.toThrow('before the response completed');
    await expect(cloudChat(openai, 'token', input)).rejects.toThrow('Plan usage limit reached');
  });

  it('rejects cloud endpoint changes before retrieving credentials', async () => {
    const token = vi.fn();
    const providers = new LocalProviders(() => ({ connections: [], mainModel: null, plannerModel: null, subagentModel: null }), token);
    await expect(providers.discover({ ...openai, url: 'http://example.com' })).rejects.toThrow('https://api.openai.com');
    expect(token).not.toHaveBeenCalled();
    expect(() => cloudEndpoint({ ...claude, auth: 'chatgpt' })).toThrow('only available for OpenAI');
    await expect(providers.chat({ profile: profile(), messages: [], signal: new AbortController().signal })).rejects.toThrow('disconnected');
  });
});
