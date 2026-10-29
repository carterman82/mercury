import { expect, it, vi } from 'vitest';
import { generateProjectReport } from './project-report';
import type { ModelProvider } from './providers';

it('reads every diagram including large diagram tails before synthesizing a concept flowchart', async () => {
  const evidence: string[] = [];
  const provider = { chat: async (input: any) => {
    evidence.push(input.messages[1].content);
    return { text: input.messages[0].content.includes('exactly one fenced') ? '```mermaid\nflowchart LR\nMain[Main] --> Storage[Storage]\n```\nData is persisted in Storage.' : 'Main sends data to Storage.', tools: [] };
  } } as unknown as ModelProvider;
  const result = await generateProjectReport(provider, { provider: 'ollama', model: 'test', contextLimit: 4000 }, [
    { path: 'system.mmd', content: 'flowchart LR\n' + 'a'.repeat(9000) + 'TAIL_MARKER' },
    { path: 'methods.mmd', content: 'SECOND_DIAGRAM' },
  ], new AbortController().signal);
  expect(evidence.join('\n')).toContain('TAIL_MARKER');
  expect(evidence.join('\n')).toContain('SECOND_DIAGRAM');
  expect(result.sources).toBe(2);
  expect(result.diagram).toContain('Main[Main] --> Storage[Storage]');
}, 15000);

const profile = { provider: 'lmstudio' as const, model: 'test', contextLimit: 262144 };
const diagrams = [{ path: 'system.mmd', content: 'flowchart LR\nMain --> Storage' }];
const complete = { text: '```mermaid\nflowchart LR\nMain --> Storage\n```', tools: [] };

it('retries length failures with more output space and returns only a completed report', async () => {
  const chat = vi.fn().mockRejectedValueOnce(new Error('The model stopped before finishing (length).')).mockResolvedValue(complete);
  const result = await generateProjectReport({ chat } as unknown as ModelProvider, profile, diagrams, new AbortController().signal);
  expect(chat.mock.calls[0][0].maxOutputTokens).toBe(8192);
  expect(chat.mock.calls[1][0].maxOutputTokens).toBe(16384);
  expect(result.diagram).toContain('Main --> Storage');
});

it('bounds repeated truncation and reports a report-specific failure', async () => {
  const chat = vi.fn().mockRejectedValue(new Error('The model stopped before finishing (length).'));
  await expect(generateProjectReport({ chat } as unknown as ModelProvider, profile, diagrams, new AbortController().signal)).rejects.toThrow('after three attempts');
  expect(chat).toHaveBeenCalledTimes(3);
});

it('does not retry unrelated provider failures', async () => {
  const chat = vi.fn().mockRejectedValue(new Error('content_filter'));
  await expect(generateProjectReport({ chat } as unknown as ModelProvider, profile, diagrams, new AbortController().signal)).rejects.toThrow('content_filter');
  expect(chat).toHaveBeenCalledTimes(1);
});

it('repairs invalid flowchart syntax before returning a report', async () => {
  const chat = vi.fn().mockResolvedValueOnce({ text: 'Main evaluates formulas.', tools: [] })
    .mockResolvedValueOnce({ text: '```mermaid\nflowchart TD\n"Main" --> "Formula"\n```', tools: [] })
    .mockResolvedValue(complete);
  const result = await generateProjectReport({ chat } as unknown as ModelProvider, profile, diagrams, new AbortController().signal);
  expect(result.diagram).toContain('Main --> Storage');
  expect(chat).toHaveBeenCalledTimes(3);
});

it('analyzes batches concurrently with Subagents and leaves final synthesis to Main', async () => {
  const worker = { ...profile, model: 'fast-subagent', contextLimit: 4000 };
  let active = 0;
  let peak = 0;
  let leases = 0;
  const inputs: any[] = [];
  const provider = {
    reserveAgent: () => { leases++; return { id: Symbol('report-worker'), profile: worker, release: () => { leases--; } }; },
    chat: async (input: any) => {
      inputs.push(input);
      if (input.profile.model === worker.model) {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        expect(input.agentLease).toBeTypeOf('symbol');
        return { text: 'Main evaluates formulas and stores data. ' + 'Storage responsibility. '.repeat(40), tools: [] };
      }
      return complete;
    },
  } as unknown as ModelProvider;
  await generateProjectReport(provider, profile, Array.from({ length: 6 }, (_, index) => ({ path: `${index}.mmd`, content: index + 'x'.repeat(900) })), new AbortController().signal, { candidates: [worker], concurrency: 3 });
  expect(peak).toBe(3);
  expect(leases).toBe(0);
  expect(inputs.at(-1).profile.model).toBe(profile.model);
  expect(inputs.filter(input => input.profile.model === worker.model)).toHaveLength(6);
});

it('sizes worker inputs and output allowance to the loaded context rather than the advertised maximum', async () => {
  const inputs: any[] = [];
  const provider = {
    loadedContextLimit: async () => 8192,
    chat: async (input: any) => { inputs.push(input); return complete; },
  } as unknown as ModelProvider;
  await generateProjectReport(provider, profile, [{ path: 'large.mmd', content: 'x'.repeat(24000) }], new AbortController().signal);
  expect(inputs.length).toBeGreaterThan(2);
  for (const input of inputs) {
    expect(input.profile.contextLimit).toBe(8192);
    expect(input.maxOutputTokens).toBe(2730);
    expect(input.messages[1].content.length).toBeLessThan(6100);
  }
});

it('builds valid Mermaid from structured conceptual nodes when model syntax is invalid', async () => {
  const chat = vi.fn().mockResolvedValueOnce({ text: 'Main uses storage.', tools: [] })
    .mockResolvedValueOnce({ text: 'Invalid diagram', tools: [] })
    .mockResolvedValue({ text: JSON.stringify({ nodes: [{ id: 'a', label: 'Main' }, { id: 'b', label: 'Content Storage' }], edges: [{ from: 'a', to: 'b', label: 'stores data' }], explanation: 'Main persists content.' }), tools: [] });
  const result = await generateProjectReport({ chat } as unknown as ModelProvider, profile, diagrams, new AbortController().signal);
  expect(result.diagram).toContain('n0 -->|stores data| n1');
  expect(result.content).toContain('Main persists content.');
});

it('analyzes repeated statements once while retaining every source diagram', async () => {
  const evidence: string[] = [];
  const chat = vi.fn(async (input: any) => { evidence.push(input.messages[1].content); return complete; });
  const result = await generateProjectReport({ chat } as unknown as ModelProvider, profile, [{ path: 'one.mmd', content: 'flowchart LR\nMain --> Storage' }, { path: 'two.mmd', content: 'flowchart LR\nMain --> Storage' }], new AbortController().signal);
  expect(result.sources).toBe(2);
  expect(evidence[0]).toContain('one.mmd');
  expect(evidence[0]).toContain('two.mmd');
  expect(evidence[0].match(/Main --> Storage/g)).toHaveLength(1);
});

it('extracts final answers rather than visible thought-channel drafts', async () => {
  const chat = vi.fn().mockResolvedValue({ text: 'Thinking Process: draft ```mermaid\ninvalid\n```<channel|>```mermaid\nflowchart LR\nMain --> Storage\n```\nFinal explanation.', tools: [] });
  const result = await generateProjectReport({ chat } as unknown as ModelProvider, profile, diagrams, new AbortController().signal);
  expect(result.diagram).toContain('Main --> Storage');
  expect(result.content).not.toContain('Thinking Process');
  expect(chat).toHaveBeenCalledTimes(2);
});
