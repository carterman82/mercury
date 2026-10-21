import { expect, it, vi } from 'vitest';
import { delegateTask, resolveModel } from './delegation';
import type { ChatInput, ModelProvider } from './providers';
import type { Settings } from '../shared/types';
import { sourceEvidence } from './source-memory';

const profile = { provider: 'ollama' as const, model: 'main', connectionId: 'server', contextLimit: 8192 };
const settings: Settings = { connections: [{ id: 'server', provider: 'ollama', label: 'Server', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: null, subagentModel: null };
const signal = () => new AbortController().signal;
const readTool = { type: 'function', function: { name: 'read_file' } };

it('resolves explicit roles and Main fallback without switching servers', () => {
  expect(resolveModel(settings, 'planner').model).toBe('main');
  expect(resolveModel(settings, 'subagent').model).toBe('main');
  expect(resolveModel({ ...settings, subagentModel: { ...profile, model: 'small' } }, 'subagent').model).toBe('small');
  expect(() => resolveModel({ ...settings, subagentModel: { ...profile, connectionId: 'missing' } }, 'subagent')).toThrow(/unavailable/);
  expect(() => resolveModel({ ...settings, mainModel: null }, 'main')).toThrow(/Select/);
});

it('uses isolated explicit context, read tools, and a bounded result', async () => {
  const requests: ChatInput[] = [];
  const provider = { chat: vi.fn(async (input: ChatInput) => {
    requests.push(structuredClone({ profile: input.profile, messages: input.messages, tools: input.tools }) as ChatInput);
    return requests.length === 1 ? { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { path: 'note.txt' } }] } : { text: 'x'.repeat(25_000), tools: [] };
  }) } as unknown as ModelProvider;
  const execute = vi.fn(async () => 'Evidence');
  const result = await delegateTask(provider, { ...profile, model: 'small' }, { task: 'Analyze', context: 'Only this context' }, signal(), [readTool], execute);
  expect(result).toHaveLength(20_000);
  expect(requests[0].profile.model).toBe('small');
  expect(requests[0].messages).toHaveLength(2);
  expect(JSON.stringify(requests[1].messages)).toContain('Evidence');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('requires substantive findings after a Subagent preamble and preserves its successful reads', async () => {
  let calls = 0; const execute = vi.fn(async () => 'Verified source total: 721');
  const provider = { chat: async (input: ChatInput) => {
    if (++calls === 1) return { text: 'Let me find the correct documentation.', tools: [] };
    if (calls === 2) return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: { path: 'note.txt' } }] };
    if (calls === 3) return { text: 'Let me review the evidence.', tools: [] };
    expect(JSON.stringify(input.messages)).toContain('Verified source total: 721');
    return { text: 'The source reports 721.', tools: [] };
  } } as unknown as ModelProvider;
  const result = await delegateTask(provider, profile, { task: 'Inspect docs', context: '' }, signal(), [readTool], execute);
  expect(result).toBe('The source reports 721.'); expect(execute).toHaveBeenCalledTimes(1); expect(calls).toBe(4);
});
it('bounds empty and status-only Subagent replies instead of returning them as findings', async () => {
  const chat = vi.fn(async () => ({ text: 'Let me inspect the source.', tools: [] }));
  await expect(delegateTask({ chat } as unknown as ModelProvider, profile, { task: 'Inspect docs', context: '' }, signal())).rejects.toThrow('two continuation attempts');
  expect(chat).toHaveBeenCalledTimes(3);
});

it.each(['delegate_task', 'edit_file', 'create_pdf', 'run_command', 'plugin_call_tool'])('rejects unauthorized Subagent tool %s before execution', async name => {
  const provider = { chat: async () => ({ text: '', tools: [{ id: 'bad', name, arguments: {} }] }) } as unknown as ModelProvider;
  const execute = vi.fn();
  await expect(delegateTask(provider, profile, { task: 'Analyze', context: '' }, signal(), [readTool], execute)).rejects.toThrow(/cannot use/);
  expect(execute).not.toHaveBeenCalled();
});

it('enforces eight turns, propagates provider failures, and rejects oversized context', async () => {
  const chat = vi.fn(async () => ({ text: '', tools: [{ id: 'read', name: 'read_file', arguments: {} }] }));
  const provider = { chat } as unknown as ModelProvider;
  await expect(delegateTask(provider, profile, { task: 'Analyze', context: '' }, signal(), [readTool], async () => 'Read')).rejects.toThrow(/8-turn/);
  expect(chat).toHaveBeenCalledTimes(8);
  chat.mockRejectedValueOnce(new Error('Server offline'));
  await expect(delegateTask(provider, profile, { task: 'Analyze', context: '' }, signal())).rejects.toThrow('Server offline');
  chat.mockClear();
  await expect(delegateTask(provider, { ...profile, contextLimit: 2048 }, { task: 'Analyze', context: 'x'.repeat(7000) }, signal())).rejects.toThrow(/context limit/);
  expect(chat).not.toHaveBeenCalled();
});

it('shares cancellation and never executes returned tools after cancellation', async () => {
  const controller = new AbortController();
  const execute = vi.fn();
  const provider = { chat: async () => { controller.abort(new Error('Stopped')); return { text: '', tools: [{ id: 'read', name: 'read_file', arguments: {} }] }; } } as unknown as ModelProvider;
  await expect(delegateTask(provider, profile, { task: 'Analyze', context: '' }, controller.signal, [readTool], execute)).rejects.toThrow('Stopped');
  expect(execute).not.toHaveBeenCalled();
});

it('lets a later Subagent recall saved findings without accessing the source again', async () => {
  const saved = sourceEvidence('browser_open', { url: 'https://example.com/report' }, 'Saved report finding: 456', 'Prior report');
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    expect((input.tools as any[]).map(tool => tool.function.name)).toEqual(['recall_context']);
    if (++calls === 1) return { text: '', tools: [{ id: 'recall', name: 'recall_context', arguments: { id: saved.id } }] };
    expect(JSON.stringify(input.messages)).toContain('Saved report finding: 456');
    return { text: '456, using the saved report', tools: [] };
  } } as unknown as ModelProvider;
  expect(await delegateTask(provider, profile, { task: 'Find the reported number', context: '' }, signal(), [], undefined, undefined, undefined, undefined, [saved])).toContain('456');
  expect(calls).toBe(2);
});
