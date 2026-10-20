import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders, type ChatInput } from './providers';
import type { CodexService } from './codex';
import type { ModelConnection, ModelInfo, ModelProfile, Settings } from '../shared/types';
import { openAIRoutes, prioritizeSubscriptions } from '../shared/openai-routing';

const api: ModelConnection = { id: 'api', provider: 'openai', label: 'OpenAI API', url: 'https://api.openai.com' };
const sub: ModelConnection = { ...api, id: 'sub', label: 'ChatGPT', auth: 'chatgpt' };
const codex: ModelConnection = { id: 'codex-account', provider: 'codex', label: 'Codex', url: 'https://chatgpt.com' };
const profile: ModelProfile = { provider: 'openai', connectionId: api.id, model: 'gpt-6.1-sol', contextLimit: 100_000 };
const catalog = (connections: ModelConnection[]): ModelInfo[] => connections.map(connection => ({ provider: connection.provider, connectionId: connection.id, connectionLabel: connection.label, id: profile.model, label: 'Model', available: true, contextLimit: 200_000 }));
const events = (...data: object[]) => new Response(data.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
const complete = () => events({ type: 'response.output_text.delta', delta: 'Done' }, { type: 'response.completed' });
function fixture(connections = [api, sub, codex]) {
  const settings: Settings = { connections, mainModel: null, plannerModel: null, subagentModel: null };
  const key = vi.fn(() => 'api-token');
  const subscriptionToken = vi.fn(async () => 'subscription-token');
  const codexChat = vi.fn(async (_input: ChatInput) => ({ text: 'Codex answer', tools: [] }));
  const provider = new LocalProviders(() => settings, key, () => {}, subscriptionToken, () => {}, { chat: codexChat } as unknown as CodexService);
  provider.rememberModels(catalog(connections), connections);
  const notice = vi.fn();
  const input = (selected = profile): ChatInput => ({ profile: selected, messages: [{ role: 'user', content: 'Hello' }], signal: new AbortController().signal, onRoutingNotice: notice });
  return { provider, key, subscriptionToken, codexChat, input, notice, settings };
}
afterEach(() => vi.unstubAllGlobals());

it('prefers a same-model ChatGPT subscription even when the API is selected', async () => {
  const f = fixture(); const fetch = vi.fn<typeof globalThis.fetch>(async () => complete()); vi.stubGlobal('fetch', fetch);
  expect((await f.provider.chat(f.input())).text).toBe('Done');
  expect((fetch.mock.calls[0][1]!.headers as Record<string, string>).authorization).toBe('Bearer subscription-token');
  expect(f.key).not.toHaveBeenCalled(); expect(f.codexChat).not.toHaveBeenCalled();
  expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('ChatGPT subscription'));
});

it('tries Codex after ChatGPT is exhausted, before using the API', async () => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response('Rate limit', { status: 429 })));
  expect((await f.provider.chat(f.input())).text).toBe('Codex answer');
  expect(f.codexChat).toHaveBeenCalledOnce(); expect(f.key).not.toHaveBeenCalled();
});

it('falls back to the selected API after both subscriptions fail, with a billing notice', async () => {
  const f = fixture(); f.codexChat.mockRejectedValue(new Error('Plan usage limit reached'));
  const fetch = vi.fn().mockResolvedValueOnce(new Response('Expired', { status: 401 })).mockResolvedValueOnce(complete()); vi.stubGlobal('fetch', fetch);
  expect((await f.provider.chat(f.input())).text).toBe('Done');
  expect(f.codexChat).toHaveBeenCalledOnce(); expect(f.key).toHaveBeenCalledWith('api');
  expect(fetch.mock.calls[1][1].headers.authorization).toBe('Bearer api-token');
  expect(f.notice.mock.calls.at(-1)?.[0]).toContain('API charges apply');
});

it('also falls back to a same-model API when a selected subscription is unavailable', async () => {
  const f = fixture([api, codex]); f.codexChat.mockRejectedValue(new Error('Codex is signed out.'));
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => complete()));
  expect((await f.provider.chat(f.input({ ...profile, provider: 'codex', connectionId: codex.id }))).text).toBe('Done');
  expect(f.key).toHaveBeenCalledOnce();
});

it('uses the API directly for an API-only model, without guessing subscription aliases', async () => {
  const f = fixture(); f.provider.rememberModels(catalog([api, sub, codex]).map(model => model.connectionId === api.id ? model : { ...model, id: 'different-model', label: profile.model }), [api, sub, codex]);
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => complete()));
  await f.provider.chat(f.input());
  expect(f.subscriptionToken).not.toHaveBeenCalled(); expect(f.codexChat).not.toHaveBeenCalled(); expect(f.key).toHaveBeenCalledOnce();
});

it.each(['text', 'reasoning', 'tool'])('never charges the API after partial %s output', async kind => {
  const f = fixture();
  const delta = kind === 'text' ? { type: 'response.output_text.delta', delta: 'Partial' } : kind === 'reasoning' ? { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' } : { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'read' } };
  const fetch = vi.fn(async () => events(delta, { type: 'response.failed', error: { message: 'Plan usage limit reached' } })); vi.stubGlobal('fetch', fetch);
  await expect(f.provider.chat(f.input())).rejects.toThrow('Plan usage limit reached');
  expect(fetch).toHaveBeenCalledOnce(); expect(f.key).not.toHaveBeenCalled(); expect(f.codexChat).not.toHaveBeenCalled();
});

it('never falls back on cancellation or malformed requests', async () => {
  const f = fixture(); const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { controller.abort(new Error('Stopped')); throw new TypeError('fetch failed'); }); vi.stubGlobal('fetch', fetch);
  await expect(f.provider.chat({ ...f.input(), signal: controller.signal })).rejects.toThrow('Stopped');
  expect(f.key).not.toHaveBeenCalled(); expect(f.codexChat).not.toHaveBeenCalled();
  fetch.mockImplementation(async () => new Response('Invalid request', { status: 400 }));
  await expect(f.provider.chat(f.input())).rejects.toThrow('Invalid request');
  expect(f.key).not.toHaveBeenCalled(); expect(f.codexChat).not.toHaveBeenCalled();
});

it('removes disconnected routes and keeps Claude/local routing unchanged', () => {
  const connections = [api, sub, codex], models = catalog(connections);
  expect(openAIRoutes(profile, [api], models).map(route => route.connectionId)).toEqual(['api']);
  expect(openAIRoutes({ ...profile, provider: 'claude' }, connections, models)).toEqual([{ ...profile, provider: 'claude' }]);
  expect(openAIRoutes({ ...profile, provider: 'ollama' }, connections, models)).toEqual([{ ...profile, provider: 'ollama' }]);
  const ordered = prioritizeSubscriptions(models, connections);
  expect(ordered.at(-1)?.connectionId).toBe(api.id);
  expect(models[0].connectionId).toBe(api.id);
  expect(openAIRoutes(profile, connections, models.map(model => ({ ...model, contextLimit: 32_768 })))[0].contextLimit).toBe(32_768);
});
