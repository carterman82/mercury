import { afterEach, expect, it, vi } from 'vitest';
import { LocalProviders } from './providers';
import type { ModelConnection, ModelProfile } from '../shared/types';

const signal = () => new AbortController().signal;
function setup(provider: 'ollama' | 'lmstudio' = 'ollama', model = 'test-model') {
  const connection: ModelConnection = { id: 'local', provider, label: 'Local', url: 'http://127.0.0.1:11434' };
  const profile: ModelProfile = { provider, model, connectionId: connection.id, contextLimit: 8192 };
  const providers = new LocalProviders(() => ({ connections: [connection], mainModel: null, plannerModel: null, subagentModel: null }), () => 'saved-secret');
  return { providers, profile, connection };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([[['completion', 'vision'], true], [['completion'], false], [[], false], [undefined, null]])('reads Ollama capabilities %j without model-name heuristics', async (capabilities, expected) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ capabilities })));
  vi.stubGlobal('fetch', fetch);
  const { providers, profile } = setup('ollama', 'gemma-qwen-vision');
  expect(await providers.viewingCapabilities(profile, signal())).toEqual({ images: expected, nativeFiles: false });
  expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/show');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ model: profile.model });
  expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer saved-secret');
});

it.each([true, false])('reads LM Studio capability %s for a loaded-instance alias', async vision => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ key: 'canonical', capabilities: { vision }, loaded_instances: [{ id: 'alias' }] }] })));
  vi.stubGlobal('fetch', fetch);
  const { providers, profile } = setup('lmstudio', 'alias');
  expect(await providers.viewingCapabilities(profile, signal())).toEqual({ images: vision, nativeFiles: false });
  expect(await providers.viewingCapabilities({ ...profile, model: 'canonical' }, signal())).toEqual({ images: vision, nativeFiles: false });
  expect(fetch).toHaveBeenCalledOnce();
});

it('uses saved capability metadata and refreshes after five minutes', async () => {
  vi.useFakeTimers();
  const { providers, profile, connection } = setup();
  providers.rememberModels([{ provider: profile.provider, connectionId: connection.id, connectionLabel: 'Local', id: profile.model, label: 'Model', available: true, visionCapable: false }], [connection]);
  const fetch = vi.fn().mockResolvedValue(new Response('{"capabilities":["vision"]}')); vi.stubGlobal('fetch', fetch);
  expect((await providers.viewingCapabilities(profile, signal())).images).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5 * 60_000);
  expect((await providers.viewingCapabilities(profile, signal())).images).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

it('keeps unavailable capability discovery unknown and honors Stop', async () => {
  const { providers, profile } = setup();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect((await providers.viewingCapabilities(profile, signal())).images).toBeNull();
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
    controller.abort(new Error('Stopped'));
    expect(init.signal.aborted).toBe(true);
    throw new Error('aborted');
  }));
  await expect(providers.viewingCapabilities(profile, controller.signal)).rejects.toThrow('Stopped');
});

it('reports cloud file viewing and leaves undiscovered Codex capability unknown', async () => {
  const { providers, profile } = setup();
  for (const provider of ['openai', 'claude'] as const) expect(await providers.viewingCapabilities({ ...profile, provider }, signal())).toEqual({ images: true, nativeFiles: true });
  expect(await providers.viewingCapabilities({ ...profile, provider: 'codex' }, signal())).toEqual({ images: null, nativeFiles: false });
});

it('skips image transmission when discovered metadata explicitly says text only', async () => {
  const { providers, profile, connection } = setup();
  providers.rememberModels([{ provider: profile.provider, connectionId: connection.id, connectionLabel: 'Local', id: profile.model, label: 'Model', available: true, visionCapable: false }], [connection]);
  const fetch = vi.fn().mockResolvedValue(new Response('{"message":{"content":"text answer"},"done":true}\n')); vi.stubGlobal('fetch', fetch);
  const onImageFallback = vi.fn();
  await providers.chat({ profile, signal: signal(), messages: [{ role: 'user', content: 'OCR text', images: [{ mimeType: 'image/png', data: 'image' }] }], onImageFallback });
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].images).toBeUndefined();
  expect(onImageFallback).toHaveBeenCalledOnce();
});
