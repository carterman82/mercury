import { afterEach, expect, it, vi } from 'vitest';
import { InactivityWatchdog } from './inactivity';
import { LocalProviders } from './providers';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('uses a rolling inactivity deadline instead of a task lifetime', async () => {
  vi.useFakeTimers(); const idle = new InactivityWatchdog(120_000, new Error('No progress'));
  for (let tick = 0; tick < 100; tick++) { await vi.advanceTimersByTimeAsync(90_000); expect(idle.signal.aborted).toBe(false); idle.progress(); }
  await vi.advanceTimersByTimeAsync(120_001); expect(idle.signal.aborted).toBe(true); expect(idle.signal.reason.message).toBe('No progress');
});
it('keeps a real provider stream alive beyond ten minutes while meaningful chunks arrive', async () => {
  vi.useFakeTimers(); let body!: ReadableStreamDefaultController<Uint8Array>; const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const fetch = vi.fn(async (_url, init: RequestInit) => { init.signal!.addEventListener('abort', () => body.error(init.signal!.reason), { once: true }); return new Response(stream); });
  vi.stubGlobal('fetch', fetch);
  const provider = new LocalProviders(() => ({ connections: [{ id: 'local', provider: 'ollama', label: 'Local', url: 'http://127.0.0.1:11434' }], mainModel: null, plannerModel: null, subagentModel: null }));
  const result = provider.chat({ profile: { provider: 'ollama', connectionId: 'local', model: 'test', contextLimit: 8192 }, messages: [], signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(0);
  for (let tick = 0; tick < 15; tick++) {
    await vi.advanceTimersByTimeAsync(90_000);
    body.enqueue(encoder.encode(JSON.stringify({ message: { thinking: `Observation ${tick}: fresh calculation.` } }) + '\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  }
  body.enqueue(encoder.encode('{"message":{"content":"Finished"},"done":true}\n')); body.close();
  await expect(result).resolves.toMatchObject({ text: 'Finished' }); expect(provider.requestCounts).toEqual([]);
});
it('pauses queued work and disposes without a late abort', async () => {
  vi.useFakeTimers(); const idle = new InactivityWatchdog(10, new Error('No progress')); idle.pause();
  await vi.advanceTimersByTimeAsync(100_000); expect(idle.signal.aborted).toBe(false); idle.progress(); idle.dispose();
  await vi.advanceTimersByTimeAsync(100_000); expect(idle.signal.aborted).toBe(false);
});
