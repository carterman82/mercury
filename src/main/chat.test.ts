import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatService } from './chat';
import { Store } from './store';
import type { ChatInput, ModelProvider } from './providers';
import { ChatFiles } from './chat-files';
import { makePdf } from './pdf';
import { cloudChat } from './cloud-providers';

const stores: Store[] = [];
const directories: string[] = [];
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'one', contextLimit: 8192 };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mercury-chat-'));
  directories.push(directory);
  const store = new Store(path.join(directory, 'state.sqlite'));
  stores.push(store);
  store.saveSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: null, subagentModel: null });
  return store;
}
afterEach(() => { stores.splice(0).forEach(store => store.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

it('retains routing and billing notices in saved replies without duplicate notices', async () => {
  const store = fixture();
  const provider = { chat: async (input: ChatInput) => {
    input.onRoutingNotice?.('Using ChatGPT subscription.');
    input.onRoutingNotice?.('Using OpenAI API; API charges apply.');
    input.onRoutingNotice?.('Using ChatGPT subscription.');
    return { text: 'Answer', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false).send(null, profile, 'Hello');
  expect(store.chat(id).messages.at(-1)?.notice).toBe('Using ChatGPT subscription.\nUsing OpenAI API; API charges apply.');
});

it.each([
  ['Give me the latest hip hop news.', 'Let me pull the latest hip hop news for you.', 'Here are the verified headlines.'],
  ['Give me Windows terminal commands.', 'Let me find the correct Windows CLI syntax.', 'Use `Get-Command` to list commands.'],
  ['Write the command line to list all files.', 'Let me find the correct Windows CLI syntax.', 'Use `Get-ChildItem` in PowerShell.'],
  ['Give me the latest hip hop news.', 'Sure!\nLet me pull the latest hip hop news for you.', 'Here are the verified headlines.'],
  ['Answer the question.', '', 'The answer is 42.'],
  ['Answer the question.', '   ', 'The answer is 42.'],
])('continues a normally stopped unfinished reply for %s', async (request, preamble, answer) => {
  const store = fixture(); let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    const text = ++calls === 1 ? preamble : answer;
    if (calls === 2) {
      expect(JSON.stringify(input.messages)).toContain('COMPLETION RECOVERY:');
      expect(JSON.stringify(input.messages)).toContain(request);
    }
    input.onText?.(text); return { text, tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false).send(null, profile, request);
  expect(calls).toBe(2); expect(store.chat(id).status).toBe('idle');
  expect(store.chat(id).messages.at(-1)?.content).toBe(answer);
});

it('continues into real search tools, preserves evidence, and does not replay tools after another preamble', async () => {
  const store = fixture(); let calls = 0;
  const execute = vi.fn(async () => ({ results: [{ url: 'https://example.com/news', title: 'Source', snippet: 'New release' }] }));
  const capabilities = { beginTurn: () => {}, endTurn: async () => {}, handles: (name: string) => name === 'web_search', execute } as any;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    if (calls === 1) return { text: 'Let me pull the latest hip hop news for you.', tools: [] };
    if (calls === 2) return { text: '', tools: [{ id: 'search', name: 'web_search', arguments: { query: 'latest hip hop news' } }] };
    if (calls === 3) return { text: 'Let me review those sources.', tools: [] };
    expect(JSON.stringify(input.messages)).toContain('https://example.com/news');
    return { text: 'The source reports a new release. [Source](https://example.com/news)', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, undefined, capabilities).send(null, profile, 'Find the latest news');
  expect(calls).toBe(4); expect(execute).toHaveBeenCalledTimes(1); expect(store.chat(id).status).toBe('idle');
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.[0].tool).toBe('web_search');
});

it('does not treat an empty response after reading a source as a completed answer', async () => {
  const store = fixture(); let calls = 0;
  const execute = vi.fn(async () => ({ url: 'https://example.com/report', content: 'Verified total: 721' }));
  const capabilities = { beginTurn: () => {}, endTurn: async () => {}, handles: () => true, execute } as any;
  const provider = { chat: async () => ++calls === 1
    ? { text: 'Let me read the report.', tools: [{ id: 'read', name: 'web_fetch', arguments: { url: 'https://example.com/report' } }] }
    : { text: calls === 2 ? '' : 'The total is 721.', tools: [] } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, undefined, capabilities).send(null, profile, 'Read the report');
  expect(calls).toBe(3); expect(execute).toHaveBeenCalledTimes(1);
  expect(store.chat(id).messages.at(-1)?.content).toContain('The total is 721.');
});

it('fails visibly after bounded status-only continuations instead of marking the request answered', async () => {
  const store = fixture(); const chat = vi.fn(async () => ({ text: 'Let me find the documentation.', tools: [] }));
  const id = await new ChatService(store, { chat } as unknown as ModelProvider, () => {}, () => false).send(null, profile, 'Find the docs');
  expect(chat).toHaveBeenCalledTimes(3); expect(store.chat(id).status).toBe('failed');
  expect(store.chat(id).error).toContain('two continuation attempts');
  expect(store.chat(id).messages.at(-1)?.completedAt).toBeDefined();
});

it.each(['Thanks!', 'Which Windows version?', 'I cannot access that private website.', '"Let me search."'])('does not add model calls for a valid brief reply: %s', async text => {
  const store = fixture(); const chat = vi.fn(async () => ({ text, tools: [] }));
  const id = await new ChatService(store, { chat } as unknown as ModelProvider, () => {}, () => false).send(null, profile, 'Help me');
  expect(chat).toHaveBeenCalledTimes(1); expect(store.chat(id).status).toBe('idle');
});

it.each(['claude', 'openai'] as const)('recovers through the actual %s request adapter with a valid continuation transcript', async provider => {
  const store = fixture(), cloudProfile = { ...profile, provider, contextLimit: 32768 };
  const connection = { id: profile.connectionId, provider, label: 'Cloud fixture', url: provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com' };
  store.saveSettings({ ...store.settings(), connections: [connection], mainModel: cloudProfile });
  const requests: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const text = requests.length === 1 ? 'Let me find the correct Windows CLI syntax.' : 'Use Get-Command in PowerShell.';
    const transcript = provider === 'claude' ? body.messages : body.input;
    // Simulate current APIs rejecting an assistant prefill. This verifies the
    // converted wire payload, including Claude's adjacent-role merging.
    if (transcript.at(-1).role !== 'user') return new Response('{"error":{"message":"Assistant prefill is unsupported"}}', { status: 400 });
    const events = provider === 'claude'
      ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]
      : [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {} }];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  }));
  try {
    const model = { chat: (input: ChatInput) => cloudChat(connection, 'fixture-key', input) } as unknown as ModelProvider;
    const id = await new ChatService(store, model, () => {}, () => false).send(null, cloudProfile, 'Give me Windows terminal commands');
    expect(requests).toHaveLength(2); expect(store.chat(id).status).toBe('idle');
    expect(store.chat(id).messages.at(-1)?.content).toBe('Use Get-Command in PowerShell.');
    expect(JSON.stringify(requests[1])).toContain('Let me find the correct Windows CLI syntax.');
  } finally { vi.unstubAllGlobals(); }
});

it('honors Stop at the continuation boundary without dispatching another generation', async () => {
  const store = fixture(); let service!: ChatService;
  const provider = { chat: vi.fn(async () => ({ text: 'Let me check the documentation.', tools: [] })) };
  const notify = () => {
    const id = service?.activeId;
    if (id && store.chat(id).messages.at(-1)?.notice?.includes('Continuing the request')) service.stop(id);
  };
  service = new ChatService(store, provider as unknown as ModelProvider, notify, () => false);
  const id = await service.send(null, profile, 'Find documentation');
  expect(provider.chat).toHaveBeenCalledTimes(1); expect(store.chat(id).status).toBe('stopped');
});

it('records prompt-to-final duration across a queue, an early preamble, a tool and delegated research', async () => {
  const store = fixture(); let now = 100_000, mainTurns = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const execute = vi.fn(async () => { now += 7000; return { url: 'https://example.com/docs', content: 'Source evidence' }; });
  const capabilities = { beginTurn: () => {}, endTurn: async () => { now += 1000; }, handles: () => true, execute } as any;
  const provider = { chat: async (input: ChatInput) => {
    if (String((input.messages[0] as any).content).includes('read-only Subagent')) { now += 9000; return { text: 'Verified findings', tools: [] }; }
    if (++mainTurns === 1) {
      input.onRequestState?.('queued'); now += 5000; input.onRequestState?.('running');
      input.onText?.('Let me check.'); now += 2000;
      return { text: 'Let me check.', tools: [{ id: 'read', name: 'web_fetch', arguments: { url: 'https://example.com/docs' } }, { id: 'delegate', name: 'delegate_task', arguments: { task: 'Analyze', context: 'Source evidence' } }] };
    }
    now += 3000; input.onText?.('Final answer'); return { text: 'Final answer', tools: [] };
  } } as unknown as ModelProvider;
  try {
    const id = await new ChatService(store, provider, () => {}, () => false, undefined, capabilities).send(null, profile, 'Research', [], 99_000);
    const reply = store.chat(id).messages.at(-1)!;
    expect(reply.startedAt).toBe(99_000); expect(reply.thinkingEndedAt).toBe(105_000);
    expect(reply.completedAt).toBe(127_000); expect(reply.completedAt! - reply.startedAt!).toBe(28_000);
    const restored = new Store(path.join(directories.at(-1)!, 'state.sqlite'));
    try { expect(restored.chat(id).messages.at(-1)?.completedAt).toBe(reply.completedAt); } finally { restored.close(); }
  } finally { clock.mockRestore(); }
});

it.each([true, false])('delegates conversation-file analysis with explicit Subagent selection: %s', async explicit => {
  const store = fixture();
  store.saveSettings({ ...store.settings(), subagentModel: explicit ? { ...profile, model: 'small' } : null });
  const root = directories.at(-1)!;
  const files = new ChatFiles(path.join(root, 'files'), async content => makePdf(content), async () => 'PDF');
  writeFileSync(path.join(root, 'note.txt'), 'Authorized evidence');
  const upload = await files.import(path.join(root, 'note.txt'));
  const requests: ChatInput[] = []; let mainTurns = 0;
  const provider = { chat: async (input: ChatInput) => {
    requests.push(input);
    if (String((input.messages[0] as any).content).includes('read-only Subagent')) {
      expect(input.profile.model).toBe(explicit ? 'small' : 'one');
      expect((input.tools as any[]).map(tool => tool.function.name)).toEqual(['read_file', 'recall_context']);
      if (input.messages.length === 2) return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { id: upload.id } }] };
      expect(JSON.stringify(input.messages)).toContain('Authorized evidence');
      return { text: 'Subagent findings', tools: [] };
    }
    if (++mainTurns === 1) return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Analyze note', context: `Read file ${upload.id}` } }] };
    expect(JSON.stringify(input.messages)).toContain('Subagent findings');
    return { text: 'Main final answer', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, files).send(null, profile, 'Analyze', [upload.id]);
  expect(store.chat(id).status).toBe('idle');
  expect(store.chat(id).messages.at(-1)?.content).toBe('Main final answer');
  expect(store.chat(id).messages.at(-1)?.toolActivity?.[0]).toMatchObject({ name: 'delegate_task', status: 'succeeded', result: 'Subagent findings' });
  expect(requests).toHaveLength(4);
});

it('returns unauthorized Subagent file reads as errors for Main to handle', async () => {
  const store = fixture();
  const root = directories.at(-1)!;
  const files = new ChatFiles(path.join(root, 'files'), async content => makePdf(content), async () => 'PDF');
  let mainTurns = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (String((input.messages[0] as any).content).includes('read-only Subagent')) return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { id: '00000000-0000-4000-8000-000000000000' } }] };
    if (++mainTurns === 1) return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Read file', context: '' } }] };
    expect(JSON.stringify(input.messages)).toContain('File is not attached');
    return { text: 'Could not access that file', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, files).send(null, profile, 'Analyze');
  expect(store.chat(id).status).toBe('idle');
  expect(store.chat(id).messages.at(-1)?.toolActivity?.[0].status).toBe('failed');
});

async function uploadSources(store: Store, count: number, content = 'Source evidence') {
  const root = directories.at(-1)!;
  const files = new ChatFiles(path.join(root, 'files'), async text => makePdf(text), async () => 'PDF');
  const uploads = [];
  for (let index = 0; index < count; index++) {
    const filename = path.join(root, `source-${index}.txt`);
    writeFileSync(filename, `${content} ${index}`);
    uploads.push(await files.import(filename));
  }
  store.saveSettings({ ...store.settings(), subagentModel: { ...profile, model: 'gemma' } });
  return { files, uploads };
}

it('accepts ten attachments and rejects an eleventh', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 11);
  store.saveSettings({ ...store.settings(), subagentModel: null });
  const provider = { chat: async () => ({ text: 'Read the attachments', tools: [] }) } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);

  await expect(service.send(null, profile, 'Read these files', uploads.slice(0, 10).map(file => file.id))).resolves.toEqual(expect.any(String));
  await expect(service.send(null, profile, 'Read these files', uploads.map(file => file.id))).rejects.toThrow('Attach up to 10 files per message.');
});

it('automatically dispatches eight files to the configured model before Main, with at most three concurrent tasks', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 8, 'Raw source only');
  let active = 0, peak = 0, completed = 0, started = 0, main = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider = { chat: async (input: ChatInput) => {
    if (input.profile.model === 'gemma') {
      started++; active++; peak = Math.max(peak, active);
      expect((input.tools as any[]).map(tool => tool.function.name)).toEqual(['read_file']);
      await gate;
      input.signal.throwIfAborted();
      active--; completed++;
      return { text: `File finding ${completed}`, tools: [] };
    }
    main++;
    expect(completed).toBe(8);
    expect(JSON.stringify(input.messages)).toContain('File finding 8');
    expect(JSON.stringify(input.messages)).not.toContain('Raw source only');
    return { text: 'Synthesized findings', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);
  const sending = service.send(null, profile, 'Compare all eight sources', uploads.map(file => file.id));
  await vi.waitFor(() => expect(started).toBe(3));
  expect(main).toBe(0);
  expect(store.chats()[0].messages.at(-1)?.notice).toContain('Using Subagents (gemma)');
  release();
  const id = await sending;
  expect(peak).toBe(3); expect(started).toBe(8); expect(main).toBe(1);
  expect(store.chat(id).status).toBe('idle');
  const response = store.chat(id).messages.at(-1)!;
  expect(response.notice).toContain('8/8 finished');
  expect(response.notice).not.toContain('0/8');
  expect(response.toolActivity).toHaveLength(8);
  expect(response.toolActivity!.every(task => task.status === 'succeeded' && task.label?.includes('gemma'))).toBe(true);
  expect(response.toolActivity?.map(task => task.label?.split(' · ')[0])).toEqual(['🌸 Subagent Flower', '🦊 Subagent Fox', '🌙 Subagent Moon', '🔥 Subagent Flame', '🍄 Subagent Mushroom', '🐙 Subagent Octopus', '⭐ Subagent Star', '🌊 Subagent Wave']);
});

it('automatically delegates a single large upload without asking Main to call a tool', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 1, 'x'.repeat(13000));
  const models: string[] = [];
  const provider = { chat: async (input: ChatInput) => {
    models.push(input.profile.model);
    return { text: input.profile.model === 'gemma' ? 'Large file findings' : 'Final answer', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, files).send(null, profile, 'Summarize', [uploads[0].id]);
  expect(models).toEqual(['gemma', 'one']);
  expect(store.chat(id).status).toBe('idle');
});

it('reports an automatic Subagent failure and passes the failed source to Main', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 2, 'Fallback evidence');
  let workers = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (input.profile.model === 'gemma') {
      if (++workers === 1) throw new Error('Gemma offline');
      return { text: 'Successful findings', tools: [] };
    }
    expect(JSON.stringify(input.messages)).toContain('Fallback evidence 0');
    expect(JSON.stringify(input.messages)).toContain('Successful findings');
    return { text: 'Answer with fallback', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, files).send(null, profile, 'Analyze', uploads.map(file => file.id));
  expect(store.chat(id).status).toBe('idle');
  expect(store.chat(id).messages.at(-1)?.notice).toContain('1 failed');
  expect(store.chat(id).messages.at(-1)?.toolActivity?.[0]).toMatchObject({ status: 'failed', result: 'Gemma offline' });
});

it('restricts automatic Subagents to their assigned source file', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 2);
  const provider = { chat: async (input: ChatInput) => {
    if (input.profile.model === 'gemma') {
      const context = JSON.stringify(input.messages);
      const other = context.includes(uploads[0].id) ? uploads[1].id : uploads[0].id;
      return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { id: other } }] };
    }
    return { text: 'Fallback answer', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, files).send(null, profile, 'Analyze', uploads.map(file => file.id));
  expect(store.chat(id).messages.at(-1)?.toolActivity?.every(task => task.status === 'failed' && task.result?.includes('not attached to this delegated task'))).toBe(true);
});

it('Stop cancels automatic workers and never calls Main or starts pending workers', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 8);
  let started = 0, cancelled = 0;
  const provider = { chat: (input: ChatInput) => {
    expect(input.profile.model).toBe('gemma'); started++;
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => { cancelled++; reject(input.signal.reason); }, { once: true }));
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);
  const sending = service.send(null, profile, 'Analyze', uploads.map(file => file.id));
  await vi.waitFor(() => expect(started).toBe(3));
  service.stop(service.activeId!);
  const id = await sending;
  expect(started).toBe(3); expect(cancelled).toBe(3);
  expect(store.chat(id).status).toBe('stopped');
  expect(store.chat(id).messages.at(-1)?.toolActivity?.every(task => task.status === 'failed')).toBe(true);
});

it('keeps conversation history when switching models and offers read-only delegation', async () => {
  const store = fixture();
  const requests: ChatInput[] = [];
  const provider = { chat: async (input: ChatInput) => { requests.push(input); input.onText?.('Hello'); return { text: 'Hello', tools: [] }; } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false);
  const id = await service.send(null, profile, 'First');
  await service.send(id, { ...profile, model: 'two' }, 'Second');
  expect(requests[1].messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Hello' }]));
  expect(requests[1].profile.model).toBe('two');
  expect(requests[1].tools).toEqual(expect.arrayContaining(['delegate_task', 'recall_context'].map(name => expect.objectContaining({ function: expect.objectContaining({ name }) }))));
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
  await expect(service.send(id, profile, 'Concurrent')).rejects.toThrow(/current response/);
  service.stop(id);
  await pending;
  expect(store.chat(id).status).toBe('stopped');
  expect(store.chat(id).messages.at(-1)?.content).toBe('Partial answer');
});

it('runs separate conversations simultaneously and stops only the selected conversation', async () => {
  const store = fixture(); const finish: ((value: any) => void)[] = [];
  const provider = { chat: (input: ChatInput) => new Promise((resolve, reject) => { finish.push(resolve); input.onText?.(String(finish.length)); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); }) } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false);
  const one = service.send(null, profile, 'First chat'); const firstId = service.activeId!;
  const two = service.send(null, profile, 'Second chat'); const secondId = service.activeIds.find(id => id !== firstId)!;
  expect(service.activeIds).toHaveLength(2); service.stop(firstId); await one;
  expect(service.activeIds).toEqual([secondId]); expect(store.chat(firstId).status).toBe('stopped');
  finish[1]({ text: 'Second answer', tools: [] }); await two;
  expect(service.activeIds).toEqual([]); expect(store.chat(secondId).status).toBe('idle');
  expect(store.chat(secondId).messages.at(-1)?.content).toBe('Second answer');
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

it.each(['automatic', 'explicit', 'empty-main'])('restores %s Subagent findings and file reads after a store restart without rereading files', async mode => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, mode === 'automatic' ? 2 : 1, 'Persisted source fact: 732 units');
  let mainTurns = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (input.profile.model === 'gemma') {
      if (input.messages.length === 2) return { text: '', tools: [{ id: 'source', name: 'read_file', arguments: { id: uploads.find(item => JSON.stringify(input.messages).includes(item.id))!.id } }] };
      return { text: 'Detailed saved finding: 732 units, from source-0.txt. Some later sections were unread.', tools: [] };
    }
    if (++mainTurns === 1 && mode !== 'automatic') return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Inspect source', context: uploads[0].id } }] };
    return { text: mode === 'empty-main' ? '' : 'Brief answer', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, files).send(null, profile, 'Analyze sources', uploads.map(item => item.id));
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.some(item => item.tool === 'delegate_task')).toBe(true);
  const root = directories.at(-1)!;
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(path.join(root, 'state.sqlite')); stores.push(reopened);
  const reads = vi.spyOn(files, 'text'); reads.mockClear();
  const followup = vi.fn(async (input: ChatInput) => {
    const context = JSON.stringify(input.messages);
    expect(context).toContain('Detailed saved finding: 732 units');
    expect(context).toContain('Some later sections were unread');
    expect(context).toContain('Persisted source fact: 732 units');
    expect(context).toContain(uploads[0].id);
    expect(context).toContain('recall_context');
    return { text: '732 units from the saved findings', tools: [] };
  });
  await new ChatService(reopened, { chat: followup } as unknown as ModelProvider, () => {}, () => false, files).send(id, profile, 'What was the exact number?');
  expect(followup).toHaveBeenCalledTimes(1); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
  expect(reopened.chat(id).status).toBe('idle');
});

it('retains webpage text, citation URL, and pagination on follow-up without another web access', async () => {
  const store = fixture(); let turns = 0;
  const execute = vi.fn(async () => ({ url: 'https://example.com/report', title: 'Original source', content: 'The recorded total was 915.', nextOffset: 14000, truncated: true }));
  const capabilities = { beginTurn: () => {}, endTurn: async () => {}, handles: (name: string) => name === 'browser_open', execute } as any;
  const provider = { chat: async () => ++turns === 1 ? { text: '', tools: [{ id: 'web', name: 'browser_open', arguments: { url: 'https://example.com/report' } }] } : { text: 'Summary without the exact total', tools: [] } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, undefined, capabilities).send(null, profile, 'Read that report');
  const item = store.chat(id).messages.at(-1)!.sourceEvidence![0];
  expect(item.result).toContain('915');
  let followupTurns = 0;
  const followup = { chat: async (input: ChatInput) => {
    expect(JSON.stringify(input.messages)).toContain('https://example.com/report');
    if (++followupTurns === 1) return { text: '', tools: [{ id: 'recall', name: 'recall_context', arguments: { id: item.id } }] };
    expect(JSON.stringify(input.messages)).toContain('915');
    expect(JSON.stringify(input.messages)).toContain('nextOffset');
    return { text: 'The saved total was 915', tools: [] };
  } } as unknown as ModelProvider;
  await new ChatService(store, followup, () => {}, () => false, undefined, capabilities).send(id, profile, 'What was that total?');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.chat(id).messages.at(-1)?.content).toContain('915');
});

it('lets a delegated researcher search and read web sources without file tools, retaining evidence for Main', async () => {
  const store = fixture(); let mainTurns = 0, researchTurns = 0;
  const execute = vi.fn(async (_chat, name) => name === 'web_search'
    ? { results: [{ title: 'Official source', url: 'https://example.com/report', snippet: 'Result' }] }
    : { url: 'https://example.com/report', content: 'The current total is 721.', nextOffset: null });
  const capabilities = { beginTurn: () => {}, endTurn: async () => {}, handles: (name: string) => ['web_search', 'web_fetch'].includes(name), execute } as any;
  const provider = { chat: async (input: ChatInput) => {
    const names = (input.tools as any[]).map(tool => tool.function.name);
    if (String((input.messages[0] as any).content).includes('read-only Subagent')) {
      expect(names).toEqual(['web_search', 'web_fetch']);
      if (++researchTurns === 1) return { text: '', tools: [{ id: 'search', name: 'web_search', arguments: { query: 'official report' } }] };
      if (researchTurns === 2) return { text: '', tools: [{ id: 'read', name: 'web_fetch', arguments: { url: 'https://example.com/report' } }] };
      expect(JSON.stringify(input.messages)).toContain('721');
      return { text: '721 from [official source](https://example.com/report)', tools: [] };
    }
    expect(names).toContain('web_search');
    if (++mainTurns === 1) return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Research current report', context: 'Find and verify the total with public web tools.' } }] };
    expect(JSON.stringify(input.messages)).toContain('721');
    return { text: 'The total is 721. [Source](https://example.com/report)', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, undefined, capabilities).send(null, profile, 'Research the report');
  expect(store.chat(id).status).toBe('idle');
  expect(execute.mock.calls.map(args => args[1])).toEqual(['web_search', 'web_fetch']);
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.map(item => item.tool)).toEqual(['web_search', 'web_fetch', 'delegate_task']);
});

it('remembers the initial excerpt of a small upload even when no Subagent or read tool was called', async () => {
  const store = fixture();
  const { files, uploads } = await uploadSources(store, 1, 'Exact source number 2468');
  const first = { chat: async () => ({ text: 'Brief overview', tools: [] }) } as unknown as ModelProvider;
  const id = await new ChatService(store, first, () => {}, () => false, files).send(null, profile, 'Summarize', [uploads[0].id]);
  const reads = vi.spyOn(files, 'text'); reads.mockClear();
  const next = { chat: async (input: ChatInput) => {
    expect(JSON.stringify(input.messages)).toContain('Exact source number 2468');
    return { text: '2468', tools: [] };
  } } as unknown as ModelProvider;
  await new ChatService(store, next, () => {}, () => false, files).send(id, profile, 'What was the number?');
  expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
});

it('reads uploads, executes PDF tool calls, persists file cards, and uses tool results in a follow-up request', async () => {
  const store = fixture();
  const root = directories.at(-1)!;
  const files = new ChatFiles(path.join(root, 'files'), async content => makePdf(content), async () => 'extracted PDF');
  writeFileSync(path.join(root, 'problem.md'), "v'(x) = 8x^(1/3) - 4x^(-1/3), v(8)=56");
  const upload = await files.import(path.join(root, 'problem.md'));
  const requests: ChatInput[] = [];
  const provider = { chat: async (input: ChatInput) => {
    requests.push(structuredClone({ profile: input.profile, messages: input.messages, tools: input.tools }) as ChatInput);
    if (requests.length === 1) return { text: '', tools: [{ id: 'pdf', name: 'create_pdf', arguments: { name: 'IVP_Solution.pdf', content: 'v(x) = 6x^(4/3) - 6x^(2/3) - 16' } }] };
    return { text: 'Your PDF is ready.', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);
  const id = await service.send(null, profile, 'Make a PDF solving this problem', [upload.id]);
  expect(JSON.stringify(requests[0].messages)).toContain('v(8)=56');
  expect(requests[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'create_pdf' }) })]));
  expect(JSON.stringify(requests[1].messages)).toContain('File created successfully');
  const chat = store.chat(id);
  expect(chat.status).toBe('idle');
  expect(chat.messages[0].files?.[0].id).toBe(upload.id);
  const pdf = chat.messages[1].files![0];
  expect(pdf.name).toBe('IVP_Solution.pdf');
  expect((await files.bytes(pdf.id)).subarray(0, 5).toString()).toBe('%PDF-');
  const reopened = new ChatFiles(path.join(root, 'files'), async content => makePdf(content), async () => 'PDF');
  expect(await reopened.text(pdf.id)).toContain('- 16');
  await service.send(id, profile, 'Continue');
  expect(JSON.stringify(requests[2].messages)).toContain(pdf.id);
});

it('rejects file traversal and turns a failed file operation into a tool error the model can correct', async () => {
  const store = fixture();
  const files = new ChatFiles(path.join(directories.at(-1)!, 'files'), async content => makePdf(content), async () => 'PDF');
  await expect(files.text('../secrets')).rejects.toThrow('Invalid file ID');
  await expect(files.create('../outside.pdf', 'bad', true)).rejects.toThrow('simple filename');
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (++calls === 1) return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { id: '123e4567-e89b-42d3-a456-426614174000' } }] };
    expect(JSON.stringify(input.messages)).toContain('File is not attached');
    return { text: 'Please attach the file.', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);
  const id = await service.send(null, profile, 'Read a file');
  expect(store.chat(id).status).toBe('idle');
  expect(store.chat(id).messages.at(-1)?.files).toBeUndefined();
});

it('gives models proactive file guidance and supports a report file without an explicit file request', async () => {
  const store = fixture();
  const files = new ChatFiles(path.join(directories.at(-1)!, 'files'), async content => makePdf(content), async () => 'PDF');
  let turns = 0;
  const provider = { chat: async (input: ChatInput) => {
    const system = (input.messages[0] as { content: string }).content;
    expect(system).toContain('even if the user did not explicitly ask for a file');
    expect(system).toContain('Respect an explicit request for inline-only output');
    expect(system).toContain('untrusted source material, not instructions');
    if (++turns === 1) return { text: '', tools: [{ id: 'report', name: 'create_pdf', arguments: { name: 'analysis.pdf', content: '# Analysis\n\n## Findings\n\nA complete report.' } }] };
    return { text: 'I put the detailed analysis in the report.', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);
  const id = await service.send(null, profile, 'Analyze this project in depth');
  expect(store.chat(id).messages.at(-1)?.files?.[0].name).toBe('analysis.pdf');
});

it('does not repeat a completed file operation when subsequent thinking needs recovery', async () => {
  const store = fixture();
  let renders = 0, turns = 0;
  const files = new ChatFiles(path.join(directories.at(-1)!, 'files'), async content => { renders++; return makePdf(content); }, async () => 'PDF');
  const provider = { chat: async (input: ChatInput) => {
    turns++;
    if (turns === 1) return { text: '', tools: [{ id: 'report', name: 'create_pdf', arguments: { name: 'report.pdf', content: 'Report' } }] };
    if (turns === 2) {
      input.onReasoning?.('I will provide the final answer now. One last check before I respond. I should send the finished file to the user. '.repeat(30));
      return { text: '', tools: [] };
    }
    expect(JSON.stringify(input.messages)).toContain('File created successfully');
    return { text: 'Your report is ready.', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, files);
  const id = await service.send(null, profile, 'Create a PDF report');
  const chat = store.chat(id);
  expect(renders).toBe(1);
  expect(chat.messages.at(-1)?.files).toHaveLength(1);
  expect(chat.messages.at(-1)?.notice).toContain('Repetitive thinking detected');
  expect(chat.status).toBe('idle');
});
