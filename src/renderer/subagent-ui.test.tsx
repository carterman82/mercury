import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ProjectAssignment, Snapshot } from '../shared/types';
import { ChatPanel } from './ChatPanel';

const profile = { provider: 'ollama' as const, model: 'worker-model', contextLimit: 32000 };
const render = (status: ProjectAssignment['status'], ordinary = false) => {
  const state: Snapshot = {
    projects: [{ id: 'project', name: 'Project', path: 'C:/project', permissionMode: 3 }], sessions: [],
    settings: { connections: [], mainModel: profile, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null,
    chats: [{ id: 'chat', projectId: ordinary ? undefined : 'project', title: 'Task', profile, status: 'streaming', updatedAt: 1,
      projectAssignments: ordinary ? [] : [{ id: 'worker', kind: 'investigation', task: 'Inspect the source', context: '', ownedPaths: [], checks: [], profile, status, createdAt: 1, updatedAt: 1, findings: 'Found the entry point', error: status === 'failed' ? 'Provider disconnected' : undefined, activity: [{ name: 'run_project_command', status: 'succeeded', at: 1, result: 'Check passed' }] }],
      messages: [{ id: 'reply', role: 'assistant', content: '', toolActivity: ordinary ? [{ name: 'delegate_task', label: '🌸 Subagent Flower · worker-model', status: 'succeeded', at: 1, result: 'Found the entry point' }] : [] }],
    }],
  };
  return renderToStaticMarkup(<ChatPanel state={state} chatId="chat" onSelect={() => {}} openSettings={() => {}} />);
};

it.each(['queued', 'running', 'completed', 'accepted', 'failed', 'interrupted'] as const)('hides the top SDK worker panel for %s assignments', status => {
  const html = render(status);
  expect(html).not.toContain('project-worker-activity');
  expect(html).not.toContain('aria-label="Subagent activity"');
  expect(html).not.toContain('Inspect the source');
  expect(html).not.toContain('Subagent findings');
  expect(html).not.toContain('Found the entry point');
  expect(html).not.toContain('Recorded checks');
  expect(html).not.toContain('Check passed');
  expect(html).not.toContain('<summary>Project workers');
  expect(html).toContain('Stop response');
});

it('keeps ordinary chat subagents on the same presentation', () => {
  const html = render('completed', true);
  expect(html).toContain('aria-label="Subagent activity"');
  expect(html).toContain('Done · 🌸 Subagent Flower · worker-model');
  expect(html).toContain('Subagent findings');
});
