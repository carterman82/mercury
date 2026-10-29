import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectReportCache, diagramHash, reportSourceCommit, type DiagramAnalysis } from './project-report-cache';
import { generateProjectReport } from './project-report';
import type { ModelProvider } from './providers';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
async function temporary() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-report-cache-')); directories.push(directory); return directory; }
const profile = { provider: 'ollama' as const, model: 'test', contextLimit: 32768 };
const report = { content: '```mermaid\nflowchart LR\nMain --> Storage\n```', diagram: 'flowchart LR\nMain --> Storage', sources: 2 };

it('persists across restart, skips unchanged diagrams even at another commit, and isolates projects', async () => {
  const directory = await temporary(), root = path.join(directory, 'project');
  const diagrams = [{ path: 'a.mmd', content: 'Main --> Storage' }];
  const generate = vi.fn(async (_previous: DiagramAnalysis[]) => ({ report, analyses: diagrams.map(source => ({ path: source.path, hash: diagramHash(source.content), notes: ['Main uses Storage.'] })) }));
  const first = await new ProjectReportCache(directory).update(root, diagrams, 'commit-one', generate);
  expect(first.lastCommit).toBe('commit-one');
  expect(first.generatedAt).toBeTruthy();
  const restarted = new ProjectReportCache(directory);
  expect(await restarted.update(root, diagrams, 'commit-two', generate)).toEqual(first);
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await restarted.read(root))?.report).toEqual(first);
  expect(await restarted.read(path.join(directory, 'other'))).toBeUndefined();
  await restarted.update(root, diagrams, 'commit-two', generate, true);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1][0]).toEqual([]);
});

it('reuses per-file findings, analyzes only edited/new files, and removes deleted/renamed evidence', async () => {
  const inputs: any[] = [];
  const provider = { chat: async (input: any) => {
    inputs.push(input);
    if (input.messages[0].content.includes('exactly one fenced')) return { text: report.content, tools: [] };
    const { fragments, statements } = JSON.parse(input.messages[1].content);
    return { text: JSON.stringify({ summaries: fragments.map((fragment: any) => ({ id: fragment.id, summary: `Findings for ${fragment.source}: ${fragment.lines.map((line: number) => statements[line]).join('\n')}` })) }), tools: [] };
  } } as unknown as ModelProvider;
  let saved: DiagramAnalysis[] = [];
  const sources = [{ path: 'a.mmd', content: 'Main --> A' }, { path: 'b.mmd', content: 'Main --> B' }, { path: 'removed.mmd', content: 'REMOVED_RELATIONSHIP' }];
  await generateProjectReport(provider, profile, sources, new AbortController().signal, { analyses: [], onAnalyses: value => { saved = value; } });
  inputs.length = 0;
  const changed = [sources[0], { path: 'b.mmd', content: 'Main --> EDITED' }, { path: 'renamed.mmd', content: 'NEW_RELATIONSHIP' }];
  await generateProjectReport(provider, profile, changed, new AbortController().signal, { analyses: saved, onAnalyses: value => { saved = value; } });
  const workers = inputs.filter(input => input.agentLease);
  expect(workers).toHaveLength(1);
  expect(workers[0].messages[1].content).not.toContain('a.mmd');
  expect(workers[0].messages[1].content).toContain('EDITED');
  expect(workers[0].messages[1].content).toContain('renamed.mmd');
  const synthesis = inputs.at(-1).messages[1].content;
  expect(synthesis).toContain('Main --> A');
  expect(synthesis).toContain('EDITED');
  expect(synthesis).not.toContain('REMOVED_RELATIONSHIP');
  expect(saved.map(entry => entry.path)).toEqual(['a.mmd', 'b.mmd', 'renamed.mmd']);
});

it('preserves the successful snapshot and commit after failure; handles corrupt caches and no Git', async () => {
  const directory = await temporary(), cache = new ProjectReportCache(directory);
  const sources = [{ path: 'dirty.mmd', content: 'before' }];
  await cache.update(directory, sources, 'old', async () => ({ report, analyses: [{ path: 'dirty.mmd', hash: diagramHash('before'), notes: ['old'] }] }));
  await expect(cache.update(directory, [{ path: 'dirty.mmd', content: 'after' }], 'new', async () => { throw new Error('Offline'); })).rejects.toThrow('Offline');
  expect((await cache.read(directory))?.report.lastCommit).toBe('old');
  const filename = (await fs.readdir(directory)).find(file => file.endsWith('.json'))!;
  await fs.writeFile(path.join(directory, filename), '{broken');
  expect(await cache.read(directory)).toBeUndefined();
  expect(await reportSourceCommit(directory)).toBeNull();
});

it('deduplicates concurrent requests for the same checkout and releases failed jobs', async () => {
  const cache = new ProjectReportCache(await temporary());
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const operation = vi.fn(async () => { await hold; return report; });
  const first = cache.run('project', operation);
  expect(cache.run('project', operation)).toBe(first);
  release(); await first;
  expect(operation).toHaveBeenCalledTimes(1);
  await expect(cache.run('project', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  await expect(cache.run('project', async () => report)).resolves.toEqual(report);
});

it('caches intermediate summaries and bounds serialized batches for small model contexts', async () => {
  let saved: DiagramAnalysis[] = [], reductions: { hash: string; summary: string }[] = [];
  const workerInputs: any[] = [];
  const provider = { chat: async (input: any) => {
    const instruction = input.messages[0].content;
    if (instruction.includes('exactly one fenced')) return { text: report.content, tools: [] };
    workerInputs.push(input);
    if (instruction.includes('Combine these architecture')) return { text: 'Main persists data in Storage.', tools: [] };
    const { fragments } = JSON.parse(input.messages[1].content);
    return { text: JSON.stringify({ summaries: fragments.map((fragment: any) => ({ id: fragment.id, summary: `Concept ${fragment.source}. ` + 'Independent source evidence. '.repeat(20) })) }), tools: [] };
  } } as unknown as ModelProvider;
  const sources = Array.from({ length: 24 }, (_, index) => ({ path: `${'long-path/'.repeat(20)}${index}.mmd`, content: `Main --> Concept${index}` }));
  const small = { ...profile, contextLimit: 8192 };
  await generateProjectReport(provider, small, sources, new AbortController().signal, { analyses: [], onAnalyses: (value, combined) => { saved = value; reductions = combined; } });
  expect(reductions.length).toBeGreaterThan(0);
  for (const input of workerInputs.filter(input => !input.messages[0].content.includes('Combine these architecture'))) expect(input.messages[1].content.length).toBeLessThanOrEqual(5943);
  workerInputs.length = 0;
  await generateProjectReport(provider, small, sources, new AbortController().signal, { analyses: saved, reductions });
  expect(workerInputs).toHaveLength(0);
});
