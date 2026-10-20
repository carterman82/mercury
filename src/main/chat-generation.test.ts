import { afterEach, expect, it, vi } from 'vitest';
import { generateChatTurn } from './chat-generation';
import { ThinkingGuard, ThinkingLimitError } from './thinking-guard';
import type { ChatInput, ModelProvider } from './providers';

const loop = 'One final check: lit could mean list or lite. I will output this. Final answer: here is a concise list of the results. Do you have initial conditions?\n\n';
const input = (): ChatInput => ({ profile: { provider: 'ollama', model: 'qwen-test', contextLimit: 8192 }, messages: [{ role: 'system', content: 'Mercury' }, { role: 'user', content: 'lit' }], signal: new AbortController().signal });
afterEach(() => vi.useRealTimers());

it('detects a repeated decision loop regardless of streaming chunk boundaries', () => {
  const guard = new ThinkingGuard();
  const text = loop.repeat(20);
  expect(() => { for (let index = 0; index < text.length; index += 37) guard.push(text.slice(index, index + 37)); }).toThrow(ThinkingLimitError);
});

it('allows substantial nonrepeating reasoning and a few repeated checks', () => {
  const guard = new ThinkingGuard();
  expect(() => {
    guard.push(loop.repeat(3));
    for (let index = 0; index < 700; index++) guard.push(`term${index} fact${index} observation${index} `);
  }).not.toThrow();
});

it('allows repeated headings while the surrounding analysis makes fresh progress', () => {
  const guard = new ThinkingGuard(Infinity);
  expect(() => { for (let step = 0; step < 20; step++) guard.push('Now check the next case with the same careful method as before. ' + Array.from({ length: 150 }, (_, word) => `case${step}observation${word}`).join(' ')); }).not.toThrow();
});

it('caps very long thinking even when the text does not repeat', () => {
  const guard = new ThinkingGuard(1500);
  expect(() => guard.push('distinct '.repeat(200))).toThrow(ThinkingLimitError);
});

it('interrupts looping generation once, preserves reasoning, and requests a direct answer without feeding the loop back', async () => {
  const requests: ChatInput[] = [];
  let reasoning = '';
  const recovery = vi.fn();
  const provider = { chat: async (request: ChatInput) => {
    requests.push(request);
    if (requests.length === 1) { request.onReasoning?.(loop.repeat(20)); return { text: '', tools: [] }; }
    return { text: 'Glad it helped!', tools: [] };
  } } as unknown as ModelProvider;
  const result = await generateChatTurn(provider, { ...input(), onReasoning: delta => { reasoning += delta; } }, recovery);
  expect(result.text).toBe('Glad it helped!');
  expect(requests).toHaveLength(2);
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests[1].disableThinking).toBe(true);
  expect(JSON.stringify(requests[1].messages)).toContain('Answer the latest user message directly now');
  expect(JSON.stringify(requests[1].messages)).not.toContain(loop);
  expect(reasoning).toContain('One final check');
  expect(recovery).toHaveBeenCalledExactlyOnceWith('repetition');
});

it('does not retry indefinitely when the second attempt also loops', async () => {
  let requests = 0;
  const provider = { chat: async (request: ChatInput) => { requests++; request.onReasoning?.(loop.repeat(20)); return { text: '', tools: [] }; } } as unknown as ModelProvider;
  await expect(generateChatTurn(provider, input(), () => {})).rejects.toThrow('kept getting stuck');
  expect(requests).toBe(2);
});

it('honors Stop without retrying and ignores late chunks from the aborted request', async () => {
  const controller = new AbortController();
  const recovery = vi.fn();
  const onText = vi.fn();
  let request!: ChatInput;
  const provider = { chat: (current: ChatInput) => { request = current; return new Promise(() => {}); } } as unknown as ModelProvider;
  const result = generateChatTurn(provider, { ...input(), signal: controller.signal, onText }, recovery);
  controller.abort(new Error('Response stopped.'));
  request.onText?.('late answer');
  await expect(result).rejects.toThrow('Response stopped');
  expect(onText).not.toHaveBeenCalled(); expect(recovery).not.toHaveBeenCalled();
});

it('bounds silent thinking time, but allows a progressing tool call to complete', async () => {
  vi.useFakeTimers();
  let requests = 0;
  const provider = { chat: async () => { requests++; if (requests === 1) return new Promise(() => {}); return { text: 'Done', tools: [] }; } } as unknown as ModelProvider;
  const recovery = vi.fn();
  const response = generateChatTurn(provider, input(), recovery);
  await vi.advanceTimersByTimeAsync(120_001);
  await expect(response).resolves.toMatchObject({ text: 'Done' });
  expect(recovery).toHaveBeenCalledExactlyOnceWith('timeout');
  let finish!: (result: any) => void; let toolRequest!: ChatInput;
  const toolProvider = { chat: (request: ChatInput) => { toolRequest = request; request.onToolProgress?.(); return new Promise(resolve => { finish = resolve; }); } } as unknown as ModelProvider;
  const toolResponse = generateChatTurn(toolProvider, input(), recovery);
  await vi.advanceTimersByTimeAsync(90_000); toolRequest.onToolProgress?.(); await vi.advanceTimersByTimeAsync(90_000);
  finish({ text: '', tools: [{ id: 'file', name: 'create_file', arguments: { name: 'long.md', content: 'Done' } }] });
  await expect(toolResponse).resolves.toHaveProperty('tools');
  expect(recovery).toHaveBeenCalledTimes(1);
});

it('keeps progressing reasoning alive beyond the old time and character budgets', async () => {
  vi.useFakeTimers(); let request!: ChatInput; let finish!: (value: any) => void;
  const provider = { chat: (current: ChatInput) => { request = current; return new Promise(resolve => { finish = resolve; }); } } as unknown as ModelProvider;
  const recovery = vi.fn(); const response = generateChatTurn(provider, input(), recovery);
  for (let step = 0; step < 15; step++) {
    await vi.advanceTimersByTimeAsync(90_000);
    request.onReasoning?.(Array.from({ length: 600 }, (_, word) => `observation${step}number${word}`).join(' '));
    expect(request.signal.aborted).toBe(false);
  }
  finish({ text: 'Done', tools: [] }); await expect(response).resolves.toMatchObject({ text: 'Done' }); expect(recovery).not.toHaveBeenCalled();
});

it('times out on real silence even after an answer starts without replaying or discarding it', async () => {
  vi.useFakeTimers(); const recovery = vi.fn(); let requests = 0;
  const provider = { chat: (current: ChatInput) => { requests++; current.onText?.('Partial answer'); return new Promise(() => {}); } } as unknown as ModelProvider;
  const response = generateChatTurn(provider, input(), recovery); const check = expect(response).rejects.toThrow('partial answer is saved');
  await vi.advanceTimersByTimeAsync(120_001); await check; expect(requests).toBe(1); expect(recovery).not.toHaveBeenCalled();
});

it('does not count time waiting for a model slot as stalled thinking', async () => {
  vi.useFakeTimers(); let request!: ChatInput; let finish!: (value: any) => void;
  const provider = { chat: (current: ChatInput) => { request = current; current.onRequestState?.('queued'); return new Promise(resolve => { finish = resolve; }); } } as unknown as ModelProvider;
  const recovery = vi.fn(); const response = generateChatTurn(provider, input(), recovery);
  await vi.advanceTimersByTimeAsync(500_000); expect(request.signal.aborted).toBe(false); expect(recovery).not.toHaveBeenCalled();
  request.onRequestState?.('running'); await vi.advanceTimersByTimeAsync(1000);
  request.onText?.('Done'); finish({ text: 'Done', tools: [] }); await expect(response).resolves.toMatchObject({ text: 'Done' });
});
