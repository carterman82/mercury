import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store';
import { ChatApprovals } from './chat-approvals';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { ChatService } from './chat';
import { hash } from './workspace';
import type { ChatInput, ModelProvider } from './providers';
import type { ChatThread } from '../shared/types';

const cleanups: (() => Promise<void>)[] = [];
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 16000 };
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode: 1 | 2 | 3 = 2, repository = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-project-tools-'));
  const root = path.join(directory, 'source'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'note.txt'), 'old');
  if (repository) {
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', root, ...args], { windowsHide: true });
    await git('init'); await git('config', 'user.name', 'Project tests'); await git('config', 'user.email', 'test@example.invalid');
    await git('add', '.'); await git('commit', '-m', 'Fixture');
  }
  const store = new Store(path.join(directory, 'state.sqlite'));
  cleanups.push(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const project = { id: randomUUID(), path: root, name: 'Fixture', permissionMode: mode, policyRevision: 1 };
  store.saveProject(project);
  store.saveSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: null, subagentModel: null });
  const chat: ChatThread = { id: randomUUID(), projectId: project.id, title: 'Project', profile, messages: [], status: 'idle', updatedAt: Date.now() };
  store.saveChat(chat);
  const approvals = new ChatApprovals(() => {});
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'workspaces')));
  const controller = new AbortController();
  await projects.prepare(chat, controller.signal);
  return { directory, root, store, project, chat, approvals, projects, controller };
}

it('reads and edits the assigned project with hashes and preserves newer user content', async () => {
  const { projects, chat, root, controller } = await fixture();
  const read = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal) as { hash: string };
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: read.hash, content: 'new' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('new');
  await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: read.hash, content: 'stale' }, controller.signal)).rejects.toThrow(/changed/);
});

it('requires an exact outside read in level 1, and denies instead of reading when rejected', async () => {
  const { directory, projects, chat, approvals, controller } = await fixture(1);
  const outside = path.join(directory, 'private.txt'); await fs.writeFile(outside, 'private');
  const pending = projects.execute(chat, 'read_project_file', { path: outside }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0]).toMatchObject({ projectId: chat.projectId, kind: 'read', paths: [outside] });
  approvals.answer(approvals.snapshot()[0].id, false);
  await expect(pending).rejects.toThrow(/denied/);
});

it('allows whole-device reads in level 2 but requires outside-write approval', async () => {
  const { directory, projects, chat, approvals, controller } = await fixture(2);
  const outside = path.join(directory, 'outside.txt'); await fs.writeFile(outside, 'outside');
  expect(await projects.execute(chat, 'read_project_file', { path: outside }, controller.signal)).toMatchObject({ hash: hash('outside') });
  const pending = projects.execute(chat, 'edit_project_file', { path: outside, expectedHash: hash('outside'), content: 'approved' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0].details).toContain('proposedContent');
  expect(approvals.snapshot()[0].details).toContain('approved');
  approvals.answer(approvals.snapshot()[0].id, true); await pending;
  expect(await fs.readFile(outside, 'utf8')).toBe('approved');
});

it('invalidates an awaiting approval when permissions change', async () => {
  const { directory, projects, chat, approvals, controller, project, store } = await fixture(1);
  const outside = path.join(directory, 'outside.txt'); await fs.writeFile(outside, 'unchanged');
  const pending = projects.execute(chat, 'edit_project_file', { path: outside, expectedHash: hash('unchanged'), content: 'wrong' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  store.saveProject({ ...project, permissionMode: 2, policyRevision: 2 });
  approvals.answer(approvals.snapshot()[0].id, true);
  await expect(pending).rejects.toThrow(/permissions changed/);
  expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
});

it('does not search a project folder replaced by a junction to an outside folder', async () => {
  const { directory, root, projects, chat, controller } = await fixture(1);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'private content');
  await fs.rename(root, path.join(directory, 'original'));
  await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(projects.execute(chat, 'search_project_files', { query: 'private' }, controller.signal)).rejects.toThrow(/identity changed/);
});

it.each([1, 2] as const)('fails closed for commands and plugin execution in restricted mode %s', async mode => {
  const { directory, projects, chat, approvals, controller } = await fixture(mode);
  const marker = path.join(directory, 'never-created.txt');
  await expect(projects.execute(chat, 'run_project_command', { command: `echo unsafe > "${marker}"` }, controller.signal)).rejects.toThrow(/confinement/);
  await expect(projects.authorizePlugin(chat, 'plugin_call_tool', {}, controller.signal)).rejects.toThrow(/confinement/);
  expect(approvals.snapshot()).toEqual([]);
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('runs a full-access command and includes its actual verification result', async () => {
  const { projects, chat, controller } = await fixture(3);
  const output = await projects.execute(chat, 'run_project_command', { command: `"${process.execPath}" -e "process.stdout.write('verified')"` }, controller.signal);
  expect(output).toMatchObject({ exitCode: 0, output: 'verified' });
});

it('shows the exact isolated diff for approval before applying it to the source project', async () => {
  const { projects, chat, root, approvals, controller } = await fixture(2, true);
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'reviewed' }, controller.signal);
  const review = await projects.execute(chat, 'review_project_changes', {}, controller.signal) as { token: string };
  const pending = projects.execute(chat, 'integrate_project_changes', { reviewToken: review.token }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0].details).toContain('reviewed');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
  approvals.answer(approvals.snapshot()[0].id, true); await pending;
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('reviewed');
});

it('rejects changes made after the integration approval was presented', async () => {
  const { projects, chat, root, approvals, controller } = await fixture(2, true);
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'presented' }, controller.signal);
  const review = await projects.execute(chat, 'review_project_changes', {}, controller.signal) as { token: string };
  const pending = projects.execute(chat, 'integrate_project_changes', { reviewToken: review.token }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  await fs.writeFile(path.join(chat.workspacePath!, 'note.txt'), 'not presented');
  approvals.answer(approvals.snapshot()[0].id, true);
  await expect(pending).rejects.toThrow(/changed after review/);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it('bounds model-facing diffs and refuses restricted integration when a full text review is unavailable', async () => {
  const { projects, chat, root, approvals, controller } = await fixture(2, true);
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'x'.repeat(120000) }, controller.signal);
  const review = await projects.execute(chat, 'review_project_changes', {}, controller.signal) as { token: string; previewTruncated: boolean };
  expect(JSON.stringify(review).length).toBeLessThan(5000); expect(review.previewTruncated).toBe(true);
  await expect(projects.execute(chat, 'integrate_project_changes', { reviewToken: review.token }, controller.signal)).rejects.toThrow(/complete text review/);
  expect(approvals.snapshot()).toEqual([]);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it('starts project conversations directly with Main, offers project reads to Subagent, and persists ownership', async () => {
  const { projects, store, project } = await fixture();
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    const names = (input.tools as any[]).map(tool => tool.function.name);
    if (calls === 1) {
      expect(String((input.messages[0] as { content: string }).content)).toContain('PROJECT CODING CONTEXT');
      expect(names).toContain('edit_project_file');
      return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Inspect note.txt', context: 'Read only note.txt.' } }] };
    }
    if (calls === 2) {
      expect(names).toContain('read_project_file'); expect(names).not.toContain('edit_project_file');
      return { text: 'The file is available for inspection.', tools: [] };
    }
    return { text: 'Ready to work on the project.', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects);
  const id = await service.send(null, profile, 'Inspect the project', [], undefined, project.id);
  expect(store.chat(id)).toMatchObject({ projectId: project.id, status: 'idle', workspacePath: project.path });
  expect(calls).toBe(3);
  await expect(service.send(id, profile, 'Move ownership', [], undefined, randomUUID())).rejects.toThrow(/different project/);
});

it('keeps project tools unavailable to ordinary chats even if a model invents their names', async () => {
  const { projects, store } = await fixture(); let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    expect((input.tools as any[]).map(tool => tool.function.name)).not.toContain('read_project_file');
    return ++calls === 1 ? { text: '', tools: [{ id: 'invented', name: 'read_project_file', arguments: { path: 'note.txt' } }] } : { text: 'No project access in this chat.', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects).send(null, profile, 'Hello');
  expect(store.chat(id).projectId).toBeUndefined();
});

it('shares revisioned notes between project chats without copying their transcripts', async () => {
  const { projects, chat, controller } = await fixture();
  const updated = await projects.execute(chat, 'update_project_notes', { expectedRevision: 0, content: 'Use deterministic fixtures.' }, controller.signal);
  expect(updated).toMatchObject({ revision: 1, content: 'Use deterministic fixtures.' });
  await expect(projects.execute(chat, 'update_project_notes', { expectedRevision: 0, content: 'Stale' }, controller.signal)).rejects.toThrow(/changed/);
  expect(await projects.execute(chat, 'read_project_notes', {}, controller.signal)).toMatchObject({ revision: 1 });
});

it('runs independent project analyses three at once and associates results in request order', async () => {
  const { projects, store, project } = await fixture();
  const waiting: (() => void)[] = []; let live = 0, maximum = 0, mainCalls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (String((input.messages[0] as any).content).includes('read-only Subagent')) {
      live++; maximum = Math.max(maximum, live);
      const task = String((input.messages[1] as any).content);
      await new Promise<void>(resolve => waiting.push(resolve)); live--;
      return { text: `Findings: ${task}`, tools: [] };
    }
    if (++mainCalls === 1) return { text: '', tools: [0, 1, 2, 3].map(index => ({ id: `delegate-${index}`, name: 'delegate_task', arguments: { task: `Independent task ${index}`, context: 'Read-only review.' } })) };
    const results = input.messages.filter((item: any) => item.role === 'tool') as any[];
    expect(results.map(item => item.tool_call_id)).toEqual(['delegate-0', 'delegate-1', 'delegate-2', 'delegate-3']);
    return { text: 'All four independent reviews are complete.', tools: [] };
  } } as unknown as ModelProvider;
  const pending = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects).send(null, profile, 'Review independent areas', [], undefined, project.id);
  await expect.poll(() => waiting.length).toBe(3);
  waiting[1](); await expect.poll(() => waiting.length).toBe(4);
  waiting[3](); waiting[2](); waiting[0]();
  const id = await pending;
  expect(maximum).toBe(3); expect(store.chat(id).status).toBe('idle');
});

it('cancels a project response when permission settings change', async () => {
  const { projects, store, project } = await fixture(3); let entered = false;
  const provider = { chat: async (input: ChatInput) => {
    entered = true;
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
    return { text: 'Must never finish.', tools: [] };
  } } as unknown as ModelProvider;
  const service = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects);
  const pending = service.send(null, profile, 'Start work', [], undefined, project.id);
  await expect.poll(() => entered).toBe(true);
  store.saveProject({ ...project, permissionMode: 1, policyRevision: 2 }); service.projectPolicyChanged(project.id);
  const id = await pending;
  expect(store.chat(id).status).toBe('stopped'); expect(store.chat(id).error).toContain('permissions changed');
});
