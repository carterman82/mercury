import { z } from 'zod';
import type { DiscoveryResult, Settings } from '../shared/types';

const provider = z.enum(['ollama', 'lmstudio', 'openai', 'claude', 'codex']);
const recordSchema = z.object({
  version: z.literal(1), key: z.string(), scannedAt: z.number().nonnegative(),
  result: z.object({
    connections: z.array(z.object({ id: z.string(), provider, label: z.string(), url: z.string().url(), deviceId: z.string().optional(), deviceLabel: z.string().optional(), hasToken: z.boolean().optional(), auth: z.literal('chatgpt').optional() })),
    models: z.array(z.object({ provider, connectionId: z.string(), connectionLabel: z.string(), id: z.string(), label: z.string(), available: z.boolean(), contextLimit: z.number().optional(), toolCapable: z.boolean().optional(), visionCapable: z.boolean().optional(), parallelRequests: z.number().int().min(1).max(32).optional() })),
    applications: z.array(z.string()), diagnostics: z.array(z.string()),
  }),
});
type CacheRecord = z.infer<typeof recordSchema>;

export function discoveryKey(settings: Settings): string {
  return JSON.stringify(settings.connections.map(({ id, provider, label, url, hasToken, auth }) => ({ id, provider, label, url, hasToken: Boolean(hasToken), auth })).sort((a, b) => a.id.localeCompare(b.id)));
}

export class DiscoveryCache {
  private record: CacheRecord | null;
  private generation = 0;
  private pending: { key: string; generation: number; promise: Promise<DiscoveryResult> } | null = null;
  constructor(private scan: (settings: Settings) => Promise<DiscoveryResult>, saved: unknown, private persist: (value: CacheRecord | null) => void, private now = Date.now) {
    const parsed = recordSchema.safeParse(saved);
    this.record = parsed.success ? parsed.data : null;
    try { if (this.record && !Array.isArray(JSON.parse(this.record.key))) this.record = null; } catch { this.record = null; }
  }
  invalidate(): void { this.generation++; this.record = null; this.persist(null); }
  peek(settings: Settings): DiscoveryResult | null {
    if (!this.record) return null;
    // Connection additions must not hide previously saved catalogs. Removed/changed
    // endpoints and authentication methods must never retain stale model choices.
    const prior = JSON.parse(this.record.key) as { id: string; provider: string; url: string; auth?: string; hasToken: boolean }[];
    const ids = new Set(settings.connections.filter(connection => prior.some(item => item.id === connection.id && item.provider === connection.provider && item.url === connection.url && item.auth === connection.auth && item.hasToken === Boolean(connection.hasToken))).map(item => item.id));
    // Auto-discovered local servers are not saved until a model is selected. Keep them
    // in the cache unless a saved connection with their ID changed.
    const result = structuredClone(this.record.result);
    result.connections = result.connections.filter(item => ids.has(item.id) || (!settings.connections.some(saved => saved.id === item.id) && (item.provider === 'lmstudio' || item.provider === 'ollama') && !prior.some(saved => saved.id === item.id)));
    const retained = new Set(result.connections.map(item => item.id));
    result.models = result.models.filter(item => retained.has(item.connectionId));
    return result;
  }
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
