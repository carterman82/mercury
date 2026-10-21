import { expect, it } from 'vitest';
import { AgentScheduler } from './agent-scheduler';
import type { ModelProfile } from '../shared/types';

const profile = (model: string, connectionId = 'local'): ModelProfile => ({ provider: 'lmstudio', model, connectionId, contextLimit: 8192 });
const first = profile('first'), second = profile('second'), remote = profile('remote', 'remote'), other = profile('other', 'other');
const scheduler = () => new AgentScheduler(p => ({ key: `${p.connectionId}:${p.model}`, device: p.connectionId!, limit: 4, active: 0 }));

it('fills Main in list order, spills past four, and reuses released capacity', () => {
  const pool = scheduler();
  const leases = Array.from({ length: 8 }, () => pool.reserve([first, second]));
  expect(leases.map(item => item.profile.model)).toEqual(['first', 'first', 'first', 'first', 'second', 'second', 'second', 'second']);
  leases[0].release(); leases[0].release();
  const next = pool.reserve([first, second]); expect(next.profile).toBe(first);
  next.release(); leases.forEach(item => item.release());
  const reordered = pool.reserve([second, first]); expect(reordered.profile).toBe(second); reordered.release();
});

it('prefers other devices for Subagents, spreads work, and falls back when they fill', () => {
  const pool = scheduler();
  const main = pool.reserve([first]);
  const leases = Array.from({ length: 8 }, () => pool.reserve([second, remote, other], first));
  expect(leases.slice(0, 2).map(item => item.profile.connectionId)).toEqual(['remote', 'other']);
  expect(leases.filter(item => item.profile === remote)).toHaveLength(4);
  expect(leases.filter(item => item.profile === other)).toHaveLength(4);
  const fallback = pool.reserve([second, remote, other], first); expect(fallback.profile).toBe(second);
  fallback.release(); leases.forEach(item => item.release()); main.release();
});

it('uses list order between equally available devices and never grants duplicate rows extra capacity', () => {
  const pool = scheduler();
  const leases = Array.from({ length: 4 }, () => pool.reserve([remote, remote, first]));
  expect(leases.every(item => item.profile === remote)).toBe(true);
  const next = pool.reserve([remote, remote, first]); expect(next.profile).toBe(first);
  next.release(); leases.forEach(item => item.release());
});

it('accounts for requests already running outside the role scheduler', () => {
  const pool = new AgentScheduler(p => ({ key: p.model, device: p.connectionId!, limit: 4, active: p.model === 'remote' ? 4 : 0 }));
  const lease = pool.reserve([remote, first], first); expect(lease.profile).toBe(first); lease.release();
});

it('counts pending leases alongside outside requests without counting leased requests twice', () => {
  let active = 3;
  const pool = new AgentScheduler(p => ({ key: p.model, device: p.connectionId!, limit: 4, active: p === first ? active : 0 }));
  const a = pool.reserve([first, remote]); expect(a.profile).toBe(first);
  const b = pool.reserve([first, remote]); expect(b.profile).toBe(remote);
  const finish = pool.requestStarted(a.id, 'first'); active++;
  const c = pool.reserve([first, remote]); expect(c.profile).toBe(remote);
  finish(); active--; a.release(); b.release(); c.release();
});
