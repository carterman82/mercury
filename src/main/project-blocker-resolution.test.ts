import { expect, it, vi } from 'vitest';
import { ChatService } from './chat';
import { newHandoff, projectActionIdentity } from './project-progress';
import { ToolFailure } from './tool-outcome';
import type { ChatThread } from '../shared/types';
import type { Store } from './store';
import type { ModelProvider } from './providers';
import type { ProjectTools } from './project-tools';
import type { ProjectAgentRuntime } from './project-agent-runtime';

const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 16000 };

it.each([
  { label: 'unchanged patch action', tool: 'patch_project_file', args: { path: 'app.ts' }, output: { hash: 'old', previousHash: 'old' }, action: true, cleared: true },
  { label: 'changed read hash', tool: 'read_project_file', args: { path: 'app.ts' }, output: { hash: 'new' }, cleared: true },
  { label: 'process changedPaths alone', tool: 'run_project_process', args: { executable: 'node' }, output: { exitCode: 0, projectChanged: true, changedPaths: ['app.ts'] }, cleared: false },
  { label: 'raw path mismatch', tool: 'read_project_file', args: { path: 'APP.ts' }, output: { hash: 'new' }, cleared: false },
  { label: 'result target ignored', tool: 'read_project_file', args: { path: 'other.ts' }, output: { hash: 'new', target: 'app.ts' }, cleared: false },
  { label: 'failed observation replaces blocker', tool: 'read_project_file', args: { path: 'app.ts' }, output: { hash: 'new', error: 'read failed' }, cleared: false },
  { label: 'validation branch retains action clearing', tool: 'patch_project_file', args: { path: 'app.ts' }, output: {}, action: true, validation: true, cleared: true },
])('characterizes persisted blocker clearing: $label', async scenario => {
  const handoff = newHandoff(undefined, 'Review source');
  handoff.requirements = [{ text: 'Reviewed', verification: 'inspection', status: 'passed', evidenceIds: ['prior'] }];
  handoff.blocker = { tool: 'patch_project_file', target: 'app.ts', code: 'PATCH_NO_MATCH', sourceRevision: 'old', message: 'no match', nextAction: 'inspect', at: 1,
    ...(scenario.action ? { action: projectActionIdentity('patch_project_file', { path: 'app.ts' }, 'PATCH_NO_MATCH') } : {}) };
  const chat: ChatThread = { id: 'chat', projectId: 'project', title: 'Review', profile, messages: [], status: 'idle', updatedAt: 1, projectHandoff: handoff };
  const store = { settings: () => ({ connections: [{ id: 'fixture', provider: 'ollama', url: 'http://unused.invalid' }] }), chat: () => chat, project: () => ({ id: 'project', permissionMode: 2 }), saveChat: vi.fn() } as unknown as Store;
  const projects = { prepare: async () => 'Project source', generation: () => 0, handles: () => true, execute: async () => scenario.output, commitResponse: async () => ({ committed: false }) } as unknown as ProjectTools;
  const runtime = { run: async input => {
    await input.execute(scenario.tool, scenario.args, scenario.validation ? { id: 'attempt', validationError: new ToolFailure('INVALID_ARGUMENTS', 'invalid') } as any : undefined);
    input.onText?.('The requested source review is complete.');
    return { text: 'The requested source review is complete.' };
  } } as ProjectAgentRuntime;
  const service = new ChatService(store, {} as ModelProvider, () => {}, () => false, undefined, undefined, projects, runtime);
  await service.send(chat.id, profile, 'Review source');
  expect(chat.projectHandoff?.blocker === undefined).toBe(scenario.cleared);
  if (scenario.output && 'error' in scenario.output) expect(chat.projectHandoff?.blocker?.tool).toBe('read_project_file');
});
