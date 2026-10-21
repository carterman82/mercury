import { expect, it } from 'vitest';
import { chatEvidence, projectEvidence, recallContext, sourceEvidence, sourceMemoryContext } from './source-memory';
import type { ChatThread, Session } from '../shared/types';

it('keeps full findings while bounding previews and pages escaped source content without loss', () => {
  const item = sourceEvidence('browser_open', { url: 'https://example.com/report' }, '"\\\n'.repeat(10000) + 'END', 'Report');
  expect(sourceMemoryContext([item], 2500).length).toBeLessThanOrEqual(2500);
  expect(sourceMemoryContext([item], 2500)).toContain('truncated');
  let offset: number | null = 0, rebuilt = '';
  while (offset !== null) {
    const raw = recallContext([item], { id: item.id, offset }, 2500);
    expect(raw.length).toBeLessThanOrEqual(2500);
    const page = JSON.parse(raw); rebuilt += page.content; offset = page.nextOffset;
  }
  expect(rebuilt).toBe(item.result);
  expect(JSON.parse(recallContext([], { id: item.id })).error).toContain('this conversation');
});

it('searches old saved evidence even when it falls outside the recent prompt preview', () => {
  const old = sourceEvidence('delegate_task', { file: 'old.txt' }, 'Unique historical finding', 'Old analysis');
  const entries = [old, ...Array.from({ length: 30 }, () => sourceEvidence('read_file', {}, 'new'.repeat(500), 'Recent'))];
  expect(sourceMemoryContext(entries, 1800)).not.toContain('Unique historical finding');
  expect(JSON.parse(recallContext(entries, { query: 'unique historical' })).matches[0].id).toBe(old.id);
  expect(sourceMemoryContext(entries, 1800).length).toBeLessThanOrEqual(1800);
});

it('keeps useful previews and advances recall pagination even with long metadata and tiny budgets', () => {
  const entries = Array.from({ length: 12 }, () => sourceEvidence('delegate_task', { context: 'x'.repeat(300) }, 'USEFUL CONTENT', 'L'.repeat(150)));
  const preview = sourceMemoryContext(entries, 6000);
  expect(preview).toContain('USEFUL CONTENT'); expect(preview.length).toBeLessThanOrEqual(6000);
  const page = JSON.parse(recallContext(entries, {}, 500));
  expect(page.matches.length).toBeGreaterThan(0); expect(page.nextOffset).toBeGreaterThan(0);
  const exact = recallContext(entries, { id: entries[0].id }, 500);
  expect(exact.length).toBeLessThanOrEqual(500); expect(JSON.parse(exact).content).toContain('USEFUL CONTENT');
});

it('restores successful legacy Subagents, excludes failed activity and reasoning, and handles empty answers', () => {
  const chat = { messages: [{ id: 'answer', role: 'assistant', content: '', reasoning: 'PRIVATE REASONING', toolActivity: [
    { name: 'delegate_task', status: 'succeeded', result: 'Useful findings', at: 1 },
    { name: 'delegate_task', status: 'failed', result: 'FAILURE', at: 2 },
    { name: 'plugin_call_tool', status: 'succeeded', result: 'SECRET', at: 3 },
  ] }] } as ChatThread;
  expect(chatEvidence(chat)).toHaveLength(1);
  expect(sourceMemoryContext(chatEvidence(chat), 4000)).toContain('Useful findings');
  expect(JSON.stringify(chatEvidence(chat))).not.toMatch(/PRIVATE|FAILURE|SECRET/);
  const session = { events: [{ id: 'legacy', role: 'subagent', kind: 'message', text: 'Project finding', at: 1 }] } as Session;
  expect(projectEvidence(session)[0].result).toBe('Project finding');
});
