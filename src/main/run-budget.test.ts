import { expect, it } from 'vitest';
import { RunBudget } from './run-budget';

it('does not consume recovery for successful project-file context reuse', async () => {
  const budget = new RunBudget();
  for (let i = 0; i < 6; i++) {
    expect(await budget.beforeTool('read_project_file', { path: 'a.ts' }, 0, async () => true)).toBeUndefined();
    budget.observe('read_project_file', { path: 'a.ts' }, { content: '1: old', hash: 'same', startLine: 1, endLine: 1 }, 0);
  }
  expect(budget.recoveries).toBe(0);
});

it('blocks the third identical failure before dispatch and shares a single recovery allowance', async () => {
  const budget = new RunBudget();
  for (let i = 0; i < 2; i++) {
    expect(await budget.beforeTool('run_project_command', { command: 'broken' }, 0)).toBeUndefined();
    budget.observe('run_project_command', { command: 'broken' }, { exitCode: 1, output: 'bad' }, 0);
  }
  expect(await budget.beforeTool('run_project_command', { command: 'broken' }, 0)).toContain('different approach');
  expect(() => budget.claimRecovery()).toThrow('one recovery');
  await expect(budget.beforeTool('run_project_command', { command: 'broken' }, 0)).rejects.toThrow('one recovery');
});

it('leaves changed and unchanged successful reads to the authorized cache and progress tracker', async () => {
  const budget = new RunBudget();
  const args = { path: 'a.ts', start: 1, end: 20 };
  for (let i = 0; i < 2; i++)
    budget.observe('read_project_file', args, { hash: 'old', content: 'a', startLine: 1, endLine: 20 }, 0);
  expect(await budget.beforeTool('read_project_file', args, 0, async () => false)).toBeUndefined();
  for (let i = 0; i < 2; i++)
    budget.observe('read_project_file', args, { hash: 'new', content: 'b', startLine: 1, endLine: 20 }, 0);
  expect(await budget.beforeTool('read_project_file', args, 0, async () => true)).toBeUndefined();
  expect(budget.recoveries).toBe(0);
});

it('detects alternating unchanged tool cycles but allows new evidence and changed projects', async () => {
  const budget = new RunBudget();
  for (let i = 0; i < 2; i++) {
    budget.observe('web_search', { query: 'a' }, { text: 'same', evidenceId: String(i) }, 0);
    budget.observe('web_fetch', { url: 'https://example.com' }, { text: 'same', evidenceId: String(i) }, 0);
  }
  expect(await budget.beforeTool('web_search', { query: 'a' }, 1)).toBeUndefined();
  for (let i = 0; i < 2; i++) {
    budget.observe('web_search', { query: 'a' }, { text: 'same' }, 1);
    budget.observe('web_fetch', { url: 'https://example.com' }, { text: 'same' }, 1);
  }
  expect(await budget.beforeTool('web_search', { query: 'a' }, 1)).toContain('different approach');
});

it('reserves the final generation for a summary and never resets counters on recovery', () => {
  const budget = new RunBudget({ generations: 3, actions: 2 });
  expect(budget.generation()).toBe(false);
  budget.claimRecovery();
  expect(budget.generation()).toBe(false);
  expect(budget.generation()).toBe(true);
  expect(() => budget.generation()).toThrow('generation');
});
