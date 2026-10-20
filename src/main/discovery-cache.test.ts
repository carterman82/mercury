import { expect, it, vi } from 'vitest';
import type { DiscoveryResult, Settings } from '../shared/types';
import { DiscoveryCache } from './discovery-cache';

const settings: Settings = { connections: [{ id: 'local', provider: 'ollama', label: 'Local', url: 'http://127.0.0.1:11434' }], defaultModel: null, overrides: {} };
const result: DiscoveryResult = { connections: settings.connections, applications: ['Ollama'], diagnostics: [], models: [{ connectionId: 'local', connectionLabel: 'Local', provider: 'ollama', id: 'model', label: 'Model', available: true }] };

it('shares concurrent scans and reuses results across settings opens and app restarts', async () => {
  let saved: unknown = null;
  const scan = vi.fn(async () => structuredClone(result));
  const cache = new DiscoveryCache(scan, null, value => { saved = value; });
  await Promise.all([cache.get(settings), cache.get(settings)]);
  const selected: Settings = { ...settings, defaultModel: { provider: 'ollama', connectionId: 'local', model: 'model', contextLimit: 8192 } };
  await cache.get(selected);
  const restarted = new DiscoveryCache(scan, saved, () => {});
  const restored = await restarted.get(selected);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(restored.models).toHaveLength(1);
  restored.models.length = 0;
  expect((await restarted.get(settings)).models).toHaveLength(1);
});

it('rescans only when forced, expired, invalidated or connection configuration changes', async () => {
  let now = 1000;
  const scan = vi.fn(async () => structuredClone(result));
  const cache = new DiscoveryCache(scan, null, () => {}, () => now);
  await cache.get(settings);
  await cache.get(settings, true);
  expect(scan).toHaveBeenCalledTimes(2);
  now += 30 * 60_000;
  await cache.get(settings);
  const changed: Settings = { ...settings, connections: [{ ...settings.connections[0], url: 'http://127.0.0.1:12345' }] };
  await cache.get(changed);
  cache.invalidate();
  await cache.get(changed);
  expect(scan).toHaveBeenCalledTimes(5);
});

it('retries empty discovery sooner and strips credentials from persisted data', async () => {
  let now = 1000, saved: unknown;
  const scan = vi.fn(async () => ({ ...result, connections: [{ ...result.connections[0], apiToken: 'secret-token' }], models: [] }));
  const cache = new DiscoveryCache(scan, null, value => { saved = value; }, () => now);
  await cache.get(settings);
  expect(JSON.stringify(saved)).not.toContain('secret-token');
  now += 59_000;
  await cache.get(settings);
  expect(scan).toHaveBeenCalledTimes(1);
  now += 1000;
  await cache.get(settings);
  expect(scan).toHaveBeenCalledTimes(2);
});

it('does not persist a scan invalidated while it was in progress', async () => {
  let finish!: (value: DiscoveryResult) => void;
  const persist = vi.fn();
  const cache = new DiscoveryCache(() => new Promise(resolve => { finish = resolve; }), null, persist);
  const pending = cache.get(settings);
  cache.invalidate();
  finish(result);
  await pending;
  expect(persist).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledWith(null);
});

it('preserves model vision and parallel-slot metadata across cache reads and restarts', async () => {
  let saved: unknown;
  const discovered = { ...result, models: result.models.map(model => ({ ...model, visionCapable: true, parallelRequests: 2 })) };
  const cache = new DiscoveryCache(async () => discovered, null, value => { saved = value; });
  expect((await cache.get(settings)).models[0]).toMatchObject({ visionCapable: true, parallelRequests: 2 });
  const restarted = new DiscoveryCache(async () => { throw new Error('Should use the cache'); }, saved, () => {});
  expect((await restarted.get(settings)).models[0]).toMatchObject({ visionCapable: true, parallelRequests: 2 });
});
