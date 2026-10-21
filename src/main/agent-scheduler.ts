import type { ModelProfile } from '../shared/types';

export interface AgentLease { id: symbol; profile: ModelProfile; release: () => void; }
export interface AgentCapacity { key: string; device: string; limit: number; active: number; }

/** Reserve synchronously across a whole task, including its read/tool turns. */
export class AgentScheduler {
  private reservations = new Map<string, { device: string; count: number; inFlight: number }>();
  private leases = new Map<symbol, string>();
  constructor(private capacity: (profile: ModelProfile) => AgentCapacity) {}
  reserve(profiles: ModelProfile[], avoid?: ModelProfile): AgentLease {
    const avoidDevice = avoid ? this.capacity(avoid).device : undefined;
    const candidates = profiles.map((profile, index) => {
      const capacity = this.capacity(profile);
      const entry = this.reservations.get(capacity.key);
      const load = Math.max(0, capacity.active - (entry?.inFlight ?? 0)) + (entry?.count ?? 0);
      const deviceBusy = [...this.reservations.values()].some(item => item.device === capacity.device && item.count > 0);
      return { profile, index, ...capacity, load, deviceBusy };
    });
    candidates.sort((a, b) => Number(a.load >= a.limit) - Number(b.load >= b.limit)
      || (avoid ? Number(a.device === avoidDevice) - Number(b.device === avoidDevice) || Number(a.deviceBusy) - Number(b.deviceBusy) : 0)
      || (a.load >= a.limit && b.load >= b.limit ? a.load / a.limit - b.load / b.limit : 0)
      || a.index - b.index);
    const chosen = candidates[0];
    if (!chosen) throw new Error('Select an agent model in Settings.');
    const entry = this.reservations.get(chosen.key) ?? { device: chosen.device, count: 0, inFlight: 0 };
    entry.count++; this.reservations.set(chosen.key, entry);
    const id = Symbol('agent-task'); this.leases.set(id, chosen.key);
    let released = false;
    return { id, profile: chosen.profile, release: () => {
      if (released) return;
      released = true;
      this.leases.delete(id);
      if (--entry.count === 0) this.reservations.delete(chosen.key);
    } };
  }
  requestStarted(id: symbol | undefined, key: string): () => void {
    const entry = id && this.leases.get(id) === key ? this.reservations.get(key) : undefined;
    if (!entry) return () => {};
    entry.inFlight++;
    return () => { entry.inFlight--; };
  }
}
