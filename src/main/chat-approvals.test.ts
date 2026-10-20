import { expect, it, vi } from 'vitest';
import { ChatApprovals } from './chat-approvals';
it('requires an exact pending ID, separates chats, and handles allow/deny/Stop exactly once', async () => {
  const approvals = new ChatApprovals(() => {}); const controller = new AbortController();
  const first = approvals.request('one', 'Install?', 'Warning', new AbortController().signal);
  const second = approvals.request('two', 'Call?', 'Arguments', new AbortController().signal);
  const third = approvals.request('three', 'Call?', 'Arguments', controller.signal);
  const [one, two, three] = approvals.snapshot();
  expect(() => approvals.answer('invented', true)).toThrow('no longer waiting');
  approvals.answer(one.id, true); await expect(first).resolves.toBeUndefined();
  approvals.answer(two.id, false); await expect(second).rejects.toThrow('denied');
  await expect(approvals.request('two', 'Different action?', '', new AbortController().signal)).rejects.toThrow('already denied');
  controller.abort(new Error('Stopped')); await expect(third).rejects.toThrow('Stopped');
  expect(() => approvals.answer(three.id, true)).toThrow(); expect(approvals.snapshot()).toEqual([]);
});
it('times out without granting permission', async () => {
  vi.useFakeTimers();
  try { const approvals = new ChatApprovals(() => {}); const pending = approvals.request('one', 'Install?', '', new AbortController().signal); const check = expect(pending).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(300_001); await check; expect(approvals.snapshot()).toEqual([]); } finally { vi.useRealTimers(); }
});

it('rejects oversized approval details rather than hiding arguments from the user', async () => {
  const approvals = new ChatApprovals(() => {});
  await expect(approvals.request('one', 'Call plugin?', 'x'.repeat(12001), new AbortController().signal)).rejects.toThrow('no permission was granted');
  expect(approvals.snapshot()).toEqual([]);
});
