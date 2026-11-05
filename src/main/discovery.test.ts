import { expect, it, vi } from 'vitest';
import type { LocalProviders } from './providers';
import { autoDiscover } from './discovery';

const commands = vi.hoisted(() => ({ pending: [] as (() => void)[], released: false }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
  const finish = () => callback(null, '{}', '');
  if (commands.released) queueMicrotask(finish);
  else commands.pending.push(finish);
} }));
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockRejectedValue(new Error('not installed')) }));

it('publishes local models while optional network discovery is still pending', async () => {
  const update = vi.fn();
  const providers = { discover: vi.fn(async (connection: { id: string; provider: string }) => [{
    id: 'qwen', label: 'Qwen', provider: connection.provider, connectionId: connection.id, connectionLabel: 'Local', available: true,
  }]) } as unknown as LocalProviders;
  const scan = autoDiscover({ connections: [], mainModel: null, plannerModel: null, subagentModel: null }, providers, update);
  try {
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(commands.pending.length).toBeGreaterThan(0);
    expect(update.mock.calls.at(-1)?.[0].models).toHaveLength(2);
  } finally {
    commands.released = true;
    commands.pending.splice(0).forEach(finish => finish());
    await scan;
  }
});
