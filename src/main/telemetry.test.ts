import { afterEach, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { measureModelRequest } from './telemetry';

afterEach(() => vi.restoreAllMocks());
function capture() {
  const span = { setAttribute: vi.fn(), addEvent: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
  vi.spyOn(trace, 'getTracer').mockReturnValue({ startActiveSpan: (_name: string, fn: (span: unknown) => unknown) => fn(span) } as any);
  return span;
}
it('records queue and usage without recording private input or output', async () => {
  const span = capture();
  const onRequestState = vi.fn();
  const input = { profile: { provider: 'ollama', model: 'private-model', endpoint: 'http://private-host', contextLimit: 8192 }, messages: [{ content: 'private-source' }], signal: new AbortController().signal, onRequestState } as any;
  const result = await measureModelRequest(input, async measured => {
    measured.onRequestState?.('queued'); measured.onRequestState?.('running');
    return { text: 'private-answer', tools: [], usage: { input: 12, output: 4 } };
  });
  expect(result.text).toBe('private-answer');
  expect(span.setAttribute).toHaveBeenCalledWith('mercury.tokens.input', 12);
  expect(onRequestState.mock.calls).toEqual([['queued'], ['running']]);
  expect(JSON.stringify(span.setAttribute.mock.calls)).not.toMatch(/private-/);
  expect(span.end).toHaveBeenCalledOnce();
});
it('records cancellation and preserves the original failure without exporting its message', async () => {
  const span = capture();
  const controller = new AbortController(); controller.abort();
  const error = new Error('secret-key');
  await expect(measureModelRequest({ profile: { provider: 'claude' }, signal: controller.signal } as any, async () => { throw error; })).rejects.toBe(error);
  expect(span.setAttribute).toHaveBeenCalledWith('mercury.cancelled', true);
  expect(JSON.stringify(span.setStatus.mock.calls)).not.toContain('secret-key');
  expect(span.end).toHaveBeenCalledOnce();
});
