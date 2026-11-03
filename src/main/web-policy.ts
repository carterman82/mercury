import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function publicAddress(address: string): boolean {
  try { return ipaddr.process(address.replace(/^\[|\]$/g, '')).range() === 'unicast'; } catch { return false; }
}

/** No credentials, local files, loopback, LAN, metadata services, or implicit redirects. */
export class WebPolicy {
  private localOrigins = new Map<string, Set<string>>();
  isLocalOrigin(chatId: string, origin: string): boolean { return this.localOrigins.get(chatId)?.has(origin) ?? false; }
  allowLocalOrigin(chatId: string, raw: string): void {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Only owned HTTP loopback origins can be registered.');
    const origins = this.localOrigins.get(chatId) ?? new Set<string>();
    origins.add(url.origin); this.localOrigins.set(chatId, origins);
  }
  revokeLocalOrigin(chatId: string, raw: string): void { this.localOrigins.get(chatId)?.delete(new URL(raw).origin); }
  constructor(private testOrigin?: string) {}
  async check(raw: string, chatId?: string): Promise<URL> {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP/HTTPS URLs without credentials are allowed.');
    if (this.testOrigin && url.origin === this.testOrigin) return url;
    if (chatId && this.localOrigins.get(chatId)?.has(url.origin)) return url;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host === 'localhost') throw new Error('Local/private network addresses are not allowed.');
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Local/private/reserved network addresses are not allowed.');
    return url;
  }
  async fetch(raw: string | URL | Request, init: RequestInit = {}, redirects: 'error' | 'manual' = 'error'): Promise<Response> {
    const url = await this.check(raw instanceof Request ? raw.url : String(raw));
    const response = await fetch(raw instanceof Request ? raw : url, { ...init, redirect: redirects, signal: init.signal ?? AbortSignal.timeout(25_000) });
    if (!response.body) return response;
    let size = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > 2_000_000) throw new Error('Service response exceeds 2 MB.'); controller.enqueue(chunk); } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  async json(url: string, signal: AbortSignal): Promise<any> {
    const response = await this.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
    if (!response.ok) throw new Error(`Service returned HTTP ${response.status}.`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Service returned no data.');
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw new Error('Service response exceeds 2 MB.'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
}
