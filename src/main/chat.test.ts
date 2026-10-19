import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatService } from './chat';
import { Store } from './store';
import type { ChatInput, ModelProvider } from './providers';

const stores: Store[] = [];
const directories: string[] = [];
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'one', contextLimit: 8192 };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mercury-chat-'));
  directories.push(directory);
  const store = new Store(path.join(directory, 'state.sqlite'));
  stores.push(store);
  store.saveSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }], defaultModel: profile, overrides: {} });
  return store;
}
afterEach(() => { stores.splice(0).forEach(store => store.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

it('keeps conversation history when testing a different model, without offering tools', async () => {
  const store = fixture();
  const requests: ChatInput[] = [];
  const provider = { chat: async (input: ChatInput) => { requests.push(input); input.onText?.('Hello'); return { text: 'Hello', tools: [] }; } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false);
  const id = await service.send(null, profile, 'First');
  await service.send(id, { ...profile, model: 'two' }, 'Second');
  expect(requests[1].messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Hello' }]));
  expect(requests[1].profile.model).toBe('two');
  expect(requests[1].tools).toBeUndefined();
  expect(store.chat(id).messages).toHaveLength(4);
  expect(service.activeId).toBeNull();
});

it('stops generation and saves partial output without starting another request', async () => {
  const store = fixture();
  const provider = { chat: (input: ChatInput) => new Promise((_resolve, reject) => {
    input.onText?.('Partial answer');
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
  }) } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false);
  const pending = service.send(null, profile, 'Hello');
  const id = service.activeId!;
  await expect(service.send(null, profile, 'Concurrent')).rejects.toThrow(/current response/);
  service.stop(id);
  await pending;
  expect(store.chat(id).status).toBe('stopped');
  expect(store.chat(id).messages.at(-1)?.content).toBe('Partial answer');
});

it('rejects context overflow and concurrent agent work before persisting a chat', async () => {
  const store = fixture();
  const provider = {} as ModelProvider;
  const busy = new ChatService(store, provider, () => {}, () => true);
  await expect(busy.send(null, profile, 'Hello')).rejects.toThrow(/current response/);
  const service = new ChatService(store, provider, () => {}, () => false);
  await expect(service.send(null, { ...profile, contextLimit: 2048 }, 'x'.repeat(7000))).rejects.toThrow(/context limit/);
  expect(store.chats()).toHaveLength(0);
});

it('saves reasoning separately and keeps it out of subsequent model prompts', async () => {
  const store = fixture();
  const requests: ChatInput[] = [];
  const provider = { chat: async (input: ChatInput) => { requests.push(input); input.onReasoning?.('Model-provided reasoning'); input.onText?.('Answer'); return { text: 'Answer', reasoning: 'Model-provided reasoning', tools: [] }; } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false);
  const id = await service.send(null, profile, 'First');
  await service.send(id, profile, 'Next');
  const saved = store.chat(id).messages[1];
  expect(saved.reasoning).toBe('Model-provided reasoning');
  expect(saved.content).toBe('Answer');
  expect(saved.completedAt).toBeGreaterThanOrEqual(saved.startedAt!);
  expect(saved.thinkingEndedAt).toBeGreaterThanOrEqual(saved.startedAt!);
  expect(JSON.stringify(requests[1].messages)).not.toContain('Model-provided reasoning');
});
