import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders } from './providers';

afterEach(() => vi.unstubAllGlobals());
it('discovers older LM Studio catalogs through compatible endpoints', async () => {
  const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('/v1/models') && !String(url).includes('/api/')
    ? new Response(JSON.stringify({ data: [{ id: 'qwen', state: 'loaded' }] }))
    : new Response('Endpoint not found', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const connection = { id: 'server', provider: 'lmstudio' as const, label: 'LM Studio', url: 'http://127.0.0.1:1234' };
  const provider = new LocalProviders(() => ({ connections: [connection], mainModel: null, plannerModel: null, subagentModel: null }));
  expect(await provider.discover(connection)).toMatchObject([{ id: 'qwen', available: true }]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([400, 422, 501])('falls back from unsupported native messages (%s)', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Anthropic messages API is not supported by this model', { status })));
  const connection = { id: 'server', provider: 'lmstudio' as const, label: 'LM Studio', url: 'http://127.0.0.1:1234' };
  const provider = new LocalProviders(() => ({ connections: [connection], mainModel: null, plannerModel: null, subagentModel: null }));
  expect(await provider.messages({ profile: { provider: 'lmstudio', connectionId: 'server', model: 'qwen', contextLimit: 8192 }, body: {}, signal: new AbortController().signal })).toBeNull();
});

it('preserves native model loading errors instead of hiding them as compatibility errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Insufficient memory to load model', { status: 400 })));
  const connection = { id: 'server', provider: 'lmstudio' as const, label: 'LM Studio', url: 'http://127.0.0.1:1234' };
  const provider = new LocalProviders(() => ({ connections: [connection], mainModel: null, plannerModel: null, subagentModel: null }));
  const response = await provider.messages({ profile: { provider: 'lmstudio', connectionId: 'server', model: 'qwen', contextLimit: 8192 }, body: {}, signal: new AbortController().signal });
  expect(response?.status).toBe(400);
  await response?.body?.cancel();
});
it('discovers Ollama loaded state and maximum architecture context without loading a model', async () => {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const address = String(url);
    const data = address.endsWith('/api/tags') ? { models: [{ name: 'loaded' }, { name: 'unloaded' }] }
      : address.endsWith('/api/ps') ? { models: [{ name: 'loaded' }] }
      : { model_info: { 'general.architecture': 'llama', 'llama.context_length': JSON.parse(init!.body as string).model === 'loaded' ? 131072 : 65536 } };
    return new Response(JSON.stringify(data));
  });
  vi.stubGlobal('fetch', fetcher);
  const connection = { id: 'server', provider: 'ollama' as const, label: 'Ollama', url: 'http://127.0.0.1:11434' };
  const provider = new LocalProviders(() => ({ connections: [connection], mainModel: null, plannerModel: null, subagentModel: null }));
  expect(await provider.discover(connection)).toMatchObject([{ id: 'loaded', available: true, contextLimit: 131072 }, { id: 'unloaded', available: false, contextLimit: 65536 }]);
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/api/chat'))).toBe(false);
});
