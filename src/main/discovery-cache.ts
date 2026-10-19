import { z } from 'zod';
import type { DiscoveryResult, Settings } from '../shared/types';

const provider = z.enum(['ollama', 'lmstudio']);
const recordSchema = z.object({
  version: z.literal(1), key: z.string(), scannedAt: z.number().nonnegative(),
  result: z.object({
    connections: z.array(z.object({ id: z.string(), provider, label: z.string(), url: z.string().url(), hasToken: z.boolean().optional() })),
    models: z.array(z.object({ provider, connectionId: z.string(), connectionLabel: z.string(), id: z.string(), label: z.string(), available: z.boolean(), contextLimit: z.number().optional(), toolCapable: z.boolean().optional() })),
    applications: z.array(z.string()), diagnostics: z.array(z.string()),
  }),
});
type CacheRecord = z.infer<typeof recordSchema>;

export function discoveryKey(settings: Settings): string {
  return JSON.stringify(settings.connections.map(({ id, provider, label, url, hasToken }) => ({ id, provider, label, url, hasToken: Boolean(hasToken) })).sort((a, b) => a.id.localeCompare(b.id)));
}

export class DiscoveryCache {
  private record: CacheRecord | null;
  private generation = 0;
  private pending: { key: string; generation: number; promise: Promise<DiscoveryResult> } | null = null;
  constructor(private scan: (settings: Settings) => Promise<DiscoveryResult>, saved: unknown, private persist: (value: CacheRecord | null) => void, private now = Date.now) {
    const parsed = recordSchema.safeParse(saved);
    this.record = parsed.success ? parsed.data : null;
  }
  invalidate(): void { this.generation++; this.record = null; this.persist(null); }
  async get(settings: Settings, force = false): Promise<DiscoveryResult> {
    const key = discoveryKey(settings);
    const age = this.record ? this.now() - this.record.scannedAt : Infinity;
    const ttl = this.record?.result.models.length ? 30 * 60_000 : 60_000;
    if (!force && this.record?.key === key && age >= 0 && age < ttl) return structuredClone(this.record.result);
    if (this.pending?.key === key && this.pending.generation === this.generation) return structuredClone(await this.pending.promise);
    const generation = this.generation;
    const promise = this.scan(structuredClone(settings)).then(result => {
      // Parse strips credentials from the persisted discovery metadata.
      const record = recordSchema.parse({ version: 1, key, scannedAt: this.now(), result });
      if (this.generation === generation && this.pending?.promise === promise) { this.record = record; this.persist(record); }
      return record.result;
    });
    this.pending = { key, generation, promise };
    try { return structuredClone(await promise); }
    finally { if (this.pending?.promise === promise) this.pending = null; }
  }
}
