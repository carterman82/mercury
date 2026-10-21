import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../shared/types';
import { ChatPanel } from './ChatPanel';

const initial = (): Snapshot => ({ projects: [{ id: 'project', name: 'Mercury project', path: 'D:\\Mercury' }], sessions: [], chats: [], settings: { connections: [], mainModel: null, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null });
const render = (state: Snapshot, projectId?: string, chatId: string | null = null) => renderToStaticMarkup(<ChatPanel state={state} projectId={projectId} chatId={chatId} onSelect={() => {}} openSettings={() => {}} />);

it('shows the selected project, default restricted permissions, and current command limitation', () => {
  const html = render(initial(), 'project');
  expect(html).toContain('Mercury project');
  expect(html).toContain('D:\\Mercury');
  expect(html).toContain('aria-label="Project permission mode"');
  expect(html).toContain('value="2" selected=""');
  expect(html).toContain('Restricted commands are unavailable');
});

it('resolves an existing chat header from persisted ownership and shows its worktree', () => {
  const state = initial();
  state.projects.push({ id: 'other', name: 'Other project', path: 'D:\\Other', permissionMode: 3 });
  state.chats.push({ id: 'chat', projectId: 'other', workspacePath: 'D:\\Worktrees\\chat', title: 'Task', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, messages: [], status: 'idle', updatedAt: 1 });
  const html = render(state, 'project', 'chat');
  expect(html).toContain('<h1>Other project</h1>');
  expect(html).toContain('Worktree · D:\\Worktrees\\chat');
  expect(html).toContain('value="3" selected=""');
  expect(html).not.toContain('Restricted commands are unavailable');
});

it('leaves ordinary chat without project permissions and labels project approvals distinctly', () => {
  const state = initial();
  expect(render(state)).not.toContain('Project permission mode');
  state.chatApprovals = [{ id: 'approval', chatId: 'chat', projectId: 'project', title: 'Read external file', details: 'D:\\Other\\source.ts', at: 1 }];
  expect(render(state, 'project', 'chat')).toContain('aria-label="Project action approval"');
});
