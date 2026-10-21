import { expect, it, vi } from 'vitest';
import { ModelRequests } from './model-requests';
import { LocalProviders, type ChatInput } from './providers';
const profile = { provider: 'lmstudio' as const, model: 'one', endpoint: 'http://127.0.0.1:1234', contextLimit: 8192 };
const signal = () => new AbortController().signal;

it('counts four active requests, queues the fifth FIFO, and releases each slot exactly once', async () => {
  const queue = new ModelRequests(); const order: string[] = [];
  const releases = await Promise.all(Array.from({ length: 4 }, () => queue.acquire('one', profile, 4, signal())));
  const fifth = queue.acquire('one', profile, 4, signal()).then(release => { order.push('five'); return release; });
  const sixth = queue.acquire('one', profile, 4, signal()).then(release => { order.push('six'); return release; });
  expect(queue.snapshot()[0]).toMatchObject({ active: 4, queued: 2, limit: 4 });
  releases[0](); releases[0](); const release5 = await fifth;
  expect(order).toEqual(['five']); expect(queue.snapshot()[0]).toMatchObject({ active: 4, queued: 1 });
  release5(); const release6 = await sixth;
  expect(order).toEqual(['five', 'six']);
  releases.slice(1).forEach(release => release()); release6(); expect(queue.snapshot()).toEqual([]);
});

it('cancels queued work without dispatching it or blocking the next waiter, with independent model pools', async () => {
  const queue = new ModelRequests(); const first = await queue.acquire('one', profile, 1, signal());
  const controller = new AbortController(); const queued = queue.acquire('one', profile, 1, controller.signal);
  const third = queue.acquire('one', profile, 1, signal());
  const other = await queue.acquire('two', { ...profile, model: 'two' }, 1, signal());
  controller.abort(new Error('Stopped')); await expect(queued).rejects.toThrow('Stopped');
  expect(queue.snapshot().find(pool => pool.model === 'one')).toMatchObject({ active: 1, queued: 1 });
  first(); (await third)(); other(); expect(queue.snapshot()).toEqual([]);
});

it('releases provider slots after success, error, and Stop, using reported model limits and endpoint aliases', async () => {
  const connection = { id: 'local', provider: 'lmstudio' as const, url: profile.endpoint, label: 'Server' };
  const providers = new LocalProviders(() => ({ connections: [connection, { ...connection, id: 'alias' }], mainModel: null, plannerModel: null, subagentModel: null }));
  providers.rememberModels([{ id: 'one', label: 'One', provider: 'lmstudio', connectionId: 'local', connectionLabel: 'Server', available: true, parallelRequests: 2 }], [connection]);
  const finish: (() => void)[] = [];
  const fetch = vi.fn((_url, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    finish.push(() => resolve(new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n')));
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  try {
    const request = (id = 'local', abortSignal = signal()): ChatInput => ({ profile: { ...profile, connectionId: id }, messages: [], signal: abortSignal });
    const first = providers.chat(request()); const second = providers.chat(request('alias'));
    const controller = new AbortController(); const third = providers.chat(request('local', controller.signal));
    await Promise.resolve(); expect(fetch).toHaveBeenCalledTimes(2);
    expect(providers.requestCounts[0]).toMatchObject({ active: 2, queued: 1, limit: 2 });
    controller.abort(new Error('Stopped')); await expect(third).rejects.toThrow('Stopped');
    finish[0](); finish[1](); await Promise.all([first, second]); expect(providers.requestCounts).toEqual([]);
    fetch.mockImplementationOnce(async () => { throw new Error('Network failed'); });
    await expect(providers.chat(request())).rejects.toThrow('Network failed'); expect(providers.requestCounts).toEqual([]);
    const stop = new AbortController(); const active = providers.chat(request('local', stop.signal)); await Promise.resolve(); stop.abort(new Error('Stopped'));
    await expect(active).rejects.toThrow('Stopped'); expect(providers.requestCounts).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});
