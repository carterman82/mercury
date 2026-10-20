import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders } from './providers';

afterEach(() => vi.unstubAllGlobals());
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
