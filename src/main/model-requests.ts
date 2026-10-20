import type { ModelProfile, ModelRequestCount } from '../shared/types';

type Waiter = { signal: AbortSignal; start: () => void; cancel: () => void };
type Pool = ModelRequestCount & { waiting: Waiter[] };

/** One FIFO pool per server/model. Every exit path releases its slot. */
export class ModelRequests {
  private pools = new Map<string, Pool>();
  constructor(private changed: () => void = () => {}) {}
  snapshot(): ModelRequestCount[] { return [...this.pools.values()].map(({ waiting, ...pool }) => ({ ...pool, queued: waiting.length })); }
  acquire(key: string, profile: ModelProfile, limit: number, signal: AbortSignal, onQueued?: () => void): Promise<() => void> {
    signal.throwIfAborted();
    let pool = this.pools.get(key);
    if (!pool) {
      pool = { key, provider: profile.provider, model: profile.model, endpoint: profile.endpoint ?? '', limit, active: 0, queued: 0, waiting: [] };
      this.pools.set(key, pool);
    }
    pool.limit = limit;
    const target = pool;
    if (target.waiting.length >= 100) return Promise.reject(new Error('This model already has 100 queued requests. Wait for a response or stop a queued chat.'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, start: () => {
        signal.removeEventListener('abort', waiter.cancel);
        target.active++;
        let released = false;
        resolve(() => {
          if (released) return; released = true;
          target.active--; this.drain(target);
        });
      }, cancel: () => {
        const index = target.waiting.indexOf(waiter);
        if (index < 0) return;
        target.waiting.splice(index, 1); signal.removeEventListener('abort', waiter.cancel);
        reject(signal.reason); this.drain(target);
      } };
      signal.addEventListener('abort', waiter.cancel, { once: true });
      target.waiting.push(waiter);
      if (target.active >= target.limit) onQueued?.();
      this.drain(target);
    });
  }
  private drain(pool: Pool): void {
    while (pool.active < pool.limit && pool.waiting.length) pool.waiting.shift()!.start();
    if (!pool.active && !pool.waiting.length) this.pools.delete(pool.key);
    this.changed();
  }
}
