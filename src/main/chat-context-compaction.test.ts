import { expect, it } from 'vitest';
import { compactChatMessages, projectContextCheckpoint, readChatHistory } from './chat-context-compaction';
import { newHandoff, recordProjectAction } from './project-handoff';
import { readProjectTask } from './project-task-state';
import type { ChatThread } from '../shared/types';

it('preserves catalog pagination and revisions in fresh-session checkpoints and task recovery', () => {
  const handoff = newHandoff(undefined, 'Research and edit every game');
  for (const startLine of [1, 201, 401]) {
    recordProjectAction(handoff, 'read_project_file', { path: 'gamesinfo.js', start: startLine, end: 500 },
      { hash: 'catalog-revision', startLine, endLine: startLine + 199 });
  }
  recordProjectAction(handoff, 'read_project_record', { path: 'gamesinfo.js', key: 'slope' }, { hash: 'catalog-revision' });
  for (const state of [JSON.parse(projectContextCheckpoint(handoff)), readProjectTask(handoff)]) {
    expect(state.reads).toEqual(handoff.reads);
    expect(state.reads.at(-1)).toMatchObject({ startLine: 401, endLine: 600, hash: 'catalog-revision' });
    expect(state.snapshots).toEqual([{ path: 'gamesinfo.js', hash: 'catalog-revision' }]);
  }
  recordProjectAction(handoff, 'patch_project_record', { path: 'gamesinfo.js', key: 'slope' },
    { path: 'gamesinfo.js', previousHash: 'catalog-revision', hash: 'edited-revision' });
  const checkpoint = JSON.parse(projectContextCheckpoint(handoff));
  expect(checkpoint.reads).toEqual([]);
  expect(checkpoint.snapshots).toEqual([{ path: 'gamesinfo.js', hash: 'edited-revision' }]);
});

it('keeps user constraints, system policy and the latest parallel tool exchange intact', () => {
  const messages = [
    { role: 'system', content: 'POLICY' },
    { role: 'user', content: 'Never switch my model.' },
    { role: 'assistant', content: 'old speculation '.repeat(3000) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', content: 'EXACT FIRST RESULT'.repeat(100), tool_call_id: 'a' },
    { role: 'tool', content: 'EXACT SECOND RESULT'.repeat(100), tool_call_id: 'b' },
  ];
  const original = structuredClone(messages);
  const result = compactChatMessages(messages, 16000);
  expect(result.compacted).toBe(true);
  expect(result.characters).toBeLessThan(16000);
  expect(result.messages.slice(0, 2)).toEqual(messages.slice(0, 2));
  expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
  expect(messages).toEqual(original);
});

it('does not truncate an oversized current user request or mandatory project checkpoint', () => {
  const messages = [{ role: 'user', content: 'exact requirement '.repeat(2000) }];
  expect(compactChatMessages(messages, 1000).messages).toEqual(messages);
  const handoff = newHandoff(undefined, 'Original objective');
  handoff.requirements = [
    {
      id: 'needed',
      text: 'Complete exact criterion',
      status: 'failed',
      verification: 'command',
      evidenceIds: ['evidence'],
    },
  ];
  handoff.blocker = {
    tool: 'run_project_process',
    target: 'app.py',
    code: 'KNOWN_FAILURE',
    message: 'Keep this failure',
    nextAction: 'Check actual output',
    at: 1,
  };
  handoff.changedPaths = ['app.py'];
  handoff.generation = 4;
  const checkpoint = JSON.parse(projectContextCheckpoint(handoff));
  expect(checkpoint.requirements).toEqual(handoff.requirements);
  expect(checkpoint.blocker).toEqual(handoff.blocker);
  expect(checkpoint.changedPaths).toEqual(['app.py']);
  expect(checkpoint.generation).toBe(4);
});

it('handles historical tool-call messages with null assistant text without dropping call-result pairs', () => {
  const messages = [
    { role: 'user', content: 'Keep this request.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'old' }] },
    { role: 'tool', content: 'large earlier result '.repeat(1000), tool_call_id: 'old' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'latest' }] },
    { role: 'tool', content: 'EXACT LATEST RESULT', tool_call_id: 'latest' },
  ];
  const result = compactChatMessages(messages as any, 8000);
  expect(result.compacted).toBe(true);
  expect(result.messages).toHaveLength(messages.length);
  expect(result.messages[1]).toEqual(messages[1]);
  expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
});

it('recovers exact paginated messages only from the current saved chat', () => {
  const content = 'a'.repeat(13000) + 'CRITICAL MIDDLE FACT' + 'b'.repeat(13000);
  const chat = { messages: [{ id: 'saved', role: 'assistant', content }] } as ChatThread;
  expect(readChatHistory(chat, {})).toMatchObject({ messages: [{ id: 'saved' }], nextOffset: null });
  const first = readChatHistory(chat, { messageId: 'saved' }) as { content: string; nextOffset: number };
  expect(first.nextOffset).toBe(12000);
  const next = readChatHistory(chat, { messageId: 'saved', offset: first.nextOffset });
  expect(next).toMatchObject({ content: content.slice(12000, 24000), nextOffset: 24000 });
  expect(JSON.stringify(next)).toContain('CRITICAL MIDDLE FACT');
  expect(() => readChatHistory(chat, { messageId: 'other-chat-message' })).toThrow('not found');
});
