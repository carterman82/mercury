import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store';
import { LocalProviders } from './providers';
import { ChatService } from './chat';
import { ChatFiles } from './chat-files';
import { resolveCandidates } from './delegation';
import type { ModelProfile } from '../shared/types';

const roots: string[] = [];
const stores: Store[] = [];
const main: ModelProfile = { provider: 'lmstudio', connectionId: 'local', model: 'main', contextLimit: 8192 };
const remote = { ...main, connectionId: 'remote' };
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mercury-pools-')); roots.push(root);
  const store = new Store(path.join(root, 'state.sqlite')); stores.push(store);
  store.saveSettings({ connections: [
    { id: 'local', provider: 'lmstudio', label: 'Local', url: 'http://127.0.0.1:1234' },
    { id: 'remote', provider: 'lmstudio', label: 'Remote', url: 'http://device-b:1234', deviceId: 'b' },
    { id: 'third', provider: 'lmstudio', label: 'Third', url: 'http://device-c:1234', deviceId: 'c' },
  ], mainModel: main, additionalMainModels: [remote], plannerModel: null, subagentModel: { ...main, model: 'sub' },
  additionalSubagentModels: [{ ...remote, model: 'sub' }, { ...main, connectionId: 'third', model: 'sub' }] });
  return { root, store, providers: new LocalProviders(() => store.settings()) };
}
const answer = (content: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n`);
afterEach(() => { vi.unstubAllGlobals(); stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('persists ordered pools and resolves endpoints without altering legacy role defaults', () => {
  const { store } = fixture();
  expect(store.settings().additionalMainModels).toEqual([remote]);
  expect(resolveCandidates(store.settings(), 'subagent').map(item => item.endpoint)).toEqual(['http://127.0.0.1:1234', 'http://device-b:1234', 'http://device-c:1234']);
  store.saveSettings({ ...store.settings(), additionalSubagentModels: [...store.settings().additionalSubagentModels!].reverse() });
  expect(resolveCandidates(store.settings(), 'subagent').map(item => item.connectionId)).toEqual(['local', 'third', 'remote']);
});

it('routes eight new Main chats four per model and releases reservations on Stop and preflight errors', async () => {
  const { store, providers } = fixture();
  const requests: { url: string; finish: () => void }[] = [];
  vi.stubGlobal('fetch', vi.fn((url, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ url: String(url), finish: () => resolve(answer('Done')) });
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })));
  const service = new ChatService(store, providers, () => {}, () => false);
  await expect(service.send(null, { ...main, contextLimit: 2048 }, 'x'.repeat(7000))).rejects.toThrow(/context limit/);
  const sending = Array.from({ length: 8 }, () => service.send(null, main, 'Hello'));
  await vi.waitFor(() => expect(requests).toHaveLength(8));
  expect(requests.filter(item => item.url.includes('127.0.0.1'))).toHaveLength(4);
  expect(requests.filter(item => item.url.includes('device-b'))).toHaveLength(4);
  expect(providers.requestCounts.every(item => item.active === 4 && item.queued === 0)).toBe(true);
  const localChat = store.chats().find(chat => chat.profile.connectionId === 'local')!;
  service.stop(localChat.id);
  await vi.waitFor(() => expect(providers.requestCounts.find(item => item.endpoint.includes('127.0.0.1'))?.active).toBe(3));
  const next = service.send(null, main, 'Next');
  await vi.waitFor(() => expect(requests).toHaveLength(9)); expect(requests.at(-1)!.url).toContain('127.0.0.1');
  requests.forEach(item => item.finish());
  const ids = await Promise.all([...sending, next]);
  expect(providers.requestCounts).toEqual([]);
  const spilled = store.chats().find(chat => chat.profile.connectionId === 'remote')!;
  expect(spilled.usesMainPool).toBe(true);
  const followup = service.send(spilled.id, spilled.profile, 'Continue');
  await vi.waitFor(() => expect(requests).toHaveLength(10));
  expect(requests.at(-1)!.url).toContain('127.0.0.1'); requests.at(-1)!.finish(); await followup;
  expect(store.chat(spilled.id).messages.filter(item => item.role === 'user')).toHaveLength(2);
  expect(ids).toHaveLength(9);
  const lease = providers.reserveAgent(resolveCandidates(store.settings(), 'main')); expect(lease.profile.connectionId).toBe('local'); lease.release();
});

it('keeps an explicitly selected nondefault model out of the Main pool', async () => {
  const { store, providers } = fixture();
  const fetch = vi.fn(async () => answer('Manual response')); vi.stubGlobal('fetch', fetch);
  const service = new ChatService(store, providers, () => {}, () => false);
  const id = await service.send(null, remote, 'Use this device');
  expect(store.chat(id).usesMainPool).toBe(false);
  await service.send(id, remote, 'Continue');
  expect(fetch.mock.calls.every((args: any[]) => String(args[0]).includes('device-b'))).toBe(true);
});

it('fans eight file tasks across remote devices before Main without exceeding four per model', async () => {
  const { store, providers, root } = fixture();
  const files = new ChatFiles(path.join(root, 'files'), async () => Buffer.from('pdf'), async () => 'PDF');
  const uploads = [];
  for (let index = 0; index < 8; index++) {
    const filename = path.join(root, `source-${index}.txt`); writeFileSync(filename, `Source ${index}`);
    uploads.push(await files.import(filename));
  }
  const requests: { url: string; model: string; finish: () => void }[] = [];
  vi.stubGlobal('fetch', vi.fn((url, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.model === 'main') return Promise.resolve(answer('Combined findings'));
    return new Promise<Response>(resolve => requests.push({ url: String(url), model: body.model, finish: () => resolve(answer('Finding')) }));
  }));
  const service = new ChatService(store, providers, () => {}, () => false, files);
  const sending = service.send(null, main, 'Compare', uploads.map(item => item.id));
  await vi.waitFor(() => expect(requests).toHaveLength(8));
  expect(requests.filter(item => item.url.includes('device-b'))).toHaveLength(4);
  expect(requests.filter(item => item.url.includes('device-c'))).toHaveLength(4);
  expect(requests.some(item => item.url.includes('127.0.0.1'))).toBe(false);
  expect(providers.requestCounts.every(item => item.active === 4 && item.queued === 0)).toBe(true);
  requests.forEach(item => item.finish());
  const id = await sending;
  expect(store.chat(id).messages.at(-1)?.content).toBe('Combined findings');
  expect(store.chat(id).status).toBe('idle'); expect(providers.requestCounts).toEqual([]);
});
