import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../shared/types';
import { ChatPanel } from './ChatPanel';

const initial = (): Snapshot => ({ projects: [{ id: 'project', name: 'Mercury project', path: 'D:\\Mercury' }], sessions: [], chats: [], settings: { connections: [], mainModel: null, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null });
const render = (state: Snapshot, projectId?: string, chatId: string | null = null) => renderToStaticMarkup(<ChatPanel state={state} projectId={projectId} chatId={chatId} onSelect={() => {}} openSettings={() => {}} />);
it('keeps verification bookkeeping out of chat while preserving replies and incomplete-work notices', () => {
  const state = initial();
  state.chats.push({ id: 'chat', projectId: 'project', title: 'Task', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, status: 'idle', updatedAt: 1,
    projectHandoff: { requirements: [{ text: 'Internal test criterion', status: 'not_run', verification: 'command', evidenceIds: [] }], reads: [], changedPaths: [], checks: [], completedSteps: [], remaining: '', updatedAt: 1 },
    messages: [{ id: 'reply', role: 'assistant', content: 'Your changes are saved.', verification: 'not_run', metrics: { queuedMs: 0, providerMs: 100, toolMs: 10, recoveries: 0 }, delivery: { status: 'blocked', reason: 'The build could not finish.', at: 1 }, toolActivity: [{ name: 'update_project_task', status: 'succeeded', at: 1, result: 'Internal test criterion' }] }],
  });
  const html = render(state, undefined, 'chat');
  for (const detail of ['Requirements and verification', 'Internal test criterion', 'Verification:', 'Run measurements', 'update_project_task']) expect(html).not.toContain(detail);
  expect(html).toContain('Your changes are saved.');
  expect(html).toContain('Work saved; not complete');
  expect(html).toContain('The build could not finish.');
});
it('keeps a blocked historical response prominent even after a successful follow-up',()=>{
  const state=initial();state.chats.push({id:'chat',projectId:'project',title:'Task',profile:{provider:'ollama',model:'test',contextLimit:8192},status:'idle',updatedAt:1,messages:[{id:'blocked',role:'assistant',content:'Everything works perfectly.',delivery:{status:'blocked',reason:'Model loading failed; no inference was tested.',at:1}},{id:'later',role:'assistant',content:'Later response.'}]});
  const html=render(state,undefined,'chat');expect(html).toContain('Work saved; not complete');expect(html).toContain('Model loading failed');expect(html).not.toContain('<details>');expect(html).toContain('Everything works perfectly.');expect(html).toContain('Later response.');
});

it.each(['idle', 'streaming'] as const)('hides thinking in %s project replies while retaining tool activity and ordinary chat thinking', status => {
  const state = initial();
  state.chats.push({ id: 'chat', projectId: 'project', title: 'Task', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, messages: [{ id: 'reply', role: 'assistant', content: 'Done.', reasoning: 'Model reasoning', startedAt: 1000, completedAt: 62000, toolActivity: [{ name: 'edit_project_file', status: 'succeeded', at: 1 }] }], status, updatedAt: 1 });
  const project = render(state, undefined, 'chat');
  expect(project).not.toContain('thinking-panel');
  expect(project).not.toContain('Model reasoning');
  expect(project).toContain('work-duration');
  if (status === 'idle') expect(project).toContain('Worked for 1m 1s');
  expect(project).toContain('Replace entire project file');
  state.chats[0].projectId = undefined;
  expect(render(state, undefined, 'chat')).toContain('thinking-panel');
});

it('shows an accessible loading bar during automatic compaction and clears it after resume', () => {
  const state = initial();
  state.chats.push({ id: 'chat', projectId: 'project', title: 'Task', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, messages: [{ id: 'reply', role: 'assistant', content: '', compaction: { phase: 'compacting', startedAt: 1000 } }], status: 'streaming', updatedAt: 1 });
  expect(render(state, undefined, 'chat')).toContain('<progress');
  expect(render(state, undefined, 'chat')).toContain('Compacting context');
  state.chats[0].messages[0].compaction!.phase = 'completed';
  expect(render(state, undefined, 'chat')).not.toContain('<progress');
});

it('shows the selected project, default restricted permissions, and current command limitation', () => {
  const html = render(initial(), 'project');
  expect(html).toContain('Mercury project');
  expect(html).toContain('D:\\Mercury');
  expect(html).toContain('aria-label="Project permission mode"');
  expect(html).toContain('value="2" selected=""');
  expect(html).toContain('Automatic isolated commands are unavailable');
  expect(html).toContain('You can approve individual commands to run with your user permissions.');
  expect(html).toContain('1 · Read-only');
  expect(html).toContain('2 · Workspace write');
  expect(html).toContain('3 · Full access');
  expect(html).not.toContain('installations always need approval');
});

it('hides generated file cards in projects while preserving uploads and ordinary chat cards', () => {
  const state = initial();
  const files = [{ id: 'generated', name: 'generated.txt', size: 20, kind: 'generated' as const }, { id: 'upload', name: 'input.txt', size: 20, kind: 'upload' as const }];
  state.chats.push({ id: 'chat', projectId: 'project', title: 'Files', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, messages: [{ id: 'message', role: 'assistant', content: 'Created files.', files }], status: 'idle', updatedAt: 1 });
  expect(render(state, 'project', 'chat')).not.toContain('Preview generated.txt');
  expect(render(state, 'project', 'chat')).toContain('Preview input.txt');
  state.chats[0].projectId = undefined;
  expect(render(state, undefined, 'chat')).toContain('Preview generated.txt');
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

it('identifies the model and tool requesting a command approval', () => {
  const state = initial();
  state.chatApprovals = [{ id: 'approval', chatId: 'chat', projectId: 'project', title: 'Allow command?', details: 'node smoke-test.js', at: 1,
    requester: { agent: 'Main', model: 'local-model', provider: 'ollama', tool: 'run_project_process' } }];
  const html = render(state, 'project', 'chat');
  expect(html).toContain('Requested by');
  expect(html).toContain('Main');
  expect(html).toContain('local-model');
  expect(html).toContain('ollama');
  expect(html).toContain('run_project_process');
  expect(html).toContain('node smoke-test.js');
});
