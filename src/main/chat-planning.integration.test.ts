import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { ChatService } from './chat';
import { ChatApprovals } from './chat-approvals';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { projectTestRuntime } from './project-test-runtime';
import type { ModelProvider } from './providers';
import { ProjectExecutionAdapter } from './project-execution';
import { ChatCapabilities } from './chat-capabilities';
import { ProjectWorkers } from './project-workers';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'planner', contextLimit: 32000 };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-planning-'));
  const store = new Store(path.join(root, 'state.sqlite'));
  const workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'source.txt'), 'original');
  const projectId = randomUUID();
  store.saveProject({ id: projectId, name: 'Fixture', path: workspace, permissionMode: 3 });
  store.saveSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: null, subagentModel: null });
  const provider = { chat: vi.fn(async () => ({ text: 'Which behavior should the proposed feature support?', tools: [] })) } as unknown as ModelProvider;
  const approvals = new ChatApprovals(() => {}, () => true);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'diagnostic', timedOut: false, confined: true }));
  const execution = { probe: vi.fn(async () => ({ available: true })), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(root, 'worktrees')), undefined, { execution });
  const service = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, projectTestRuntime(provider));
  cleanup.push(async () => { store.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, workspace, projectId, store, provider, approvals, execute, execution, projects, service };
}

it('enters /plan without inference, stays in planning on follow-up, and exits explicitly', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  expect(f.provider.chat).not.toHaveBeenCalled();
  expect(f.store.chat(id).collaborationMode).toBe('plan');
  await f.service.send(id, profile, 'Add a feature for managing exports');
  expect(f.store.chat(id).collaborationMode).toBe('plan');
  expect(f.store.chat(id).status).toBe('idle');
  await f.service.send(id, profile, '/plan off');
  expect(f.store.chat(id).collaborationMode).toBe('default');
});

it('blocks forged edits and escalation in Plan mode even under Full access', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  await f.projects.prepare(chat, new AbortController().signal);
  await expect(f.projects.execute(chat, 'edit_project_file', { path: 'source.txt', expectedHash: null, content: 'changed' }, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAN_MODE_READ_ONLY' });
  await expect(f.projects.execute(chat, 'run_project_command', { command: 'echo changed', sandboxPermissions: 'require_escalated' }, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAN_MODE_READ_ONLY' });
  expect(await fs.readFile(path.join(f.workspace, 'source.txt'), 'utf8')).toBe('original');
  expect(f.approvals.snapshot()).toEqual([]);
});

it('confines planning diagnostics and never offers an unrestricted retry', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  await f.projects.prepare(chat, new AbortController().signal);
  f.execute.mockResolvedValue({ exitCode: 1, output: 'EACCES permission denied', timedOut: false, confined: true });
  const result = await f.projects.execute(chat, 'run_project_command', { command: 'node --version' }, new AbortController().signal);
  expect(result).toMatchObject({ exitCode: 1, confined: true });
  expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ writableRoots: [], confined: true, network: 'deny' }), expect.any(AbortSignal));
  expect(f.execute).not.toHaveBeenCalledWith(expect.objectContaining({ approvedNative: true }), expect.any(AbortSignal));
  expect(f.approvals.snapshot()).toEqual([]);
});

it('requires the current proposal revision before implementation and preserves user step checkoffs', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  chat.workPlan = { revision: 2, origin: 'explicit', objective: 'Add exports', proposal: 'Implement exports and test them.', steps: [{ id: randomUUID(), text: 'Implement exports', status: 'pending' }], updatedAt: Date.now() };
  f.store.saveChat(chat);
  await expect(f.service.implementPlan(id, 1)).rejects.toThrow(/changed|revision/i);
  expect(f.store.chat(id).collaborationMode).toBe('plan');
  await f.service.implementPlan(id, 2);
  const implemented = f.store.chat(id);
  expect(implemented.collaborationMode).toBe('default');
  expect(JSON.stringify(vi.mocked(f.provider.chat).mock.calls)).toContain('Implement exports and test them.');
  f.service.togglePlanStep(id, implemented.workPlan!.steps[0].id, true, implemented.workPlan!.revision);
  expect(f.store.chat(id).workPlan!.steps[0].status).toBe('completed');
  expect(f.store.chat(id).projectHandoff?.requirements).toEqual([]);
});

it('automatically saves a lightweight execution plan for a substantial request without entering Plan mode', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, 'Implement a new export workflow with a settings screen, saved presets, and integration tests.', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  expect(chat.collaborationMode).not.toBe('plan');
  expect(chat.workPlan?.origin).toBe('automatic');
  expect(chat.workPlan!.steps.length).toBeGreaterThanOrEqual(3);
  expect(f.provider.chat).toHaveBeenCalled();
  expect(f.approvals.snapshot()).toEqual([]);
});

it('rejects forged implementation tools at model dispatch and saves a proposal without delivery repairs', async () => {
  const f = await fixture();
  vi.mocked(f.provider.chat).mockResolvedValueOnce({ text: '', tools: [{ id: 'forged', name: 'edit_project_file', arguments: { path: 'forbidden.txt', expectedHash: null, content: 'bad' } }] })
    .mockResolvedValueOnce({ text: '<proposed_plan>\n# Export feature\n- Inspect the current export flow\n- Add presets\n- Test exports\n</proposed_plan>', tools: [] });
  const id = await f.service.send(null, profile, '/plan Add an export feature with presets', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  expect(chat.status, chat.error).toBe('idle');
  expect(chat.collaborationMode).toBe('plan');
  expect(chat.workPlan?.proposal).toContain('# Export feature');
  expect(chat.messages.at(-1)?.toolActivity?.[0]).toMatchObject({ status: 'failed' });
  expect(chat.messages.at(-1)?.toolActivity?.[0].result).toContain('PLAN_MODE_READ_ONLY');
  expect(f.provider.chat).toHaveBeenCalledTimes(2);
  await expect(fs.stat(path.join(f.workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(chat.projectHandoff?.requirements).toEqual([]);
  const second = new Store(path.join(f.root, 'state.sqlite'));
  try { expect(second.chat(id).workPlan).toEqual(chat.workPlan); expect(second.chat(id).collaborationMode).toBe('plan'); }
  finally { second.close(); }
});

it('fails closed for planning commands when isolation is unavailable without asking for escalation', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  await f.projects.prepare(chat, new AbortController().signal);
  vi.mocked(f.execution.probe).mockResolvedValue({ available: false, version: '1.0.1' });
  await expect(f.projects.execute(chat, 'run_project_command', { command: 'node --version' }, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAN_MODE_SANDBOX_UNAVAILABLE' });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.approvals.snapshot()).toEqual([]);
});

it('blocks direct capability and coding-worker calls while planning', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  const capabilities = new ChatCapabilities({} as never, {} as never, undefined, chatId => f.store.chat(chatId).collaborationMode === 'plan');
  for (const name of ['install_plugin', 'plugin_call_tool', 'browser_fill', 'browser_pointer']) {
    await expect(capabilities.execute(id, name, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAN_MODE_READ_ONLY' });
  }
  const workers = new ProjectWorkers(f.store, f.provider, projectTestRuntime(f.provider), f.projects, new ProjectWorktreeService(path.join(f.root, 'workers')), () => {});
  await expect(workers.start(chat, { kind: 'implementation', task: 'Edit source', context: '', ownedPaths: ['source.txt'] }, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAN_MODE_READ_ONLY' });
  expect(f.provider.chat).not.toHaveBeenCalled();
});

it.runIf(process.env.MERCURY_LIVE_MXC === '1')('enforces actual read-only diagnostics for a full-access planning chat', async () => {
  const f = await fixture();
  const id = await f.service.send(null, profile, '/plan', [], undefined, f.projectId);
  const chat = f.store.chat(id);
  const execution = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(f.root, 'scratch'));
  const projects = new ProjectTools(f.store, f.approvals, new ProjectWorktreeService(path.join(f.root, 'live-worktrees')), undefined, { execution });
  const signal = new AbortController().signal;
  try {
    await projects.prepare(chat, signal);
    const result: any = await projects.execute(chat, 'run_project_process', { executable: process.execPath, args: ['-'], stdin: `const fs=require('node:fs');try{fs.writeFileSync('source.txt','escaped');throw new Error('WRITE ESCAPED')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}console.log('planning confinement verified');` }, signal);
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, confined: true, projectChanged: false });
    expect(result.output).toContain('planning confinement verified');
    expect(await fs.readFile(path.join(f.workspace, 'source.txt'), 'utf8')).toBe('original');
    expect(f.approvals.snapshot()).toEqual([]);
  } finally { await execution.shutdown(); }
}, 45000);
