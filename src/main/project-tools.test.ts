import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store';
import { ChatApprovals } from './chat-approvals';
import { ProjectTools, projectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { ChatService } from './chat';
import { hash } from './workspace';
import type { ChatInput, ModelProvider } from './providers';
import type { ChatThread } from '../shared/types';
import { projectTestRuntime } from './project-test-runtime';
import { ProjectExecutionAdapter } from './project-execution';
import { ChatFiles } from './chat-files';
import { ProjectWorkers } from './project-workers';
import { ProjectMaps } from './project-maps';
import { ClaudeProjectRuntime, PROJECT_RUNTIME_BUILD } from './project-agent-runtime';
import { ChatBrowser } from './chat-browser';
import { WebPolicy } from './web-policy';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { newHandoff } from './project-handoff';
import { beginProjectRequest } from './project-task-policy';
import { sourceEvidence } from './source-memory';
import { ProjectContextRollover } from './project-context-rollover';

const cleanups: (() => Promise<void>)[] = [];

it('reuses authorized unchanged pages with fresh editable revisions across equivalent paths and bounds', async () => {
  const { root, chat, projects, controller, store } = await fixture(3);
  await fs.writeFile(path.join(root, 'pages.txt'), Array.from({ length: 291 }, (_, i) => `line ${i + 1}`).join('\n'));
  const first: any = await projects.execute(chat, 'read_project_file', { path: 'pages.txt' }, controller.signal);
  const evidence = sourceEvidence('read_project_file', { path: 'pages.txt' }, first);
  store.indexSourceEvidence('chat', chat.id, [evidence]); projects.recordReadEvidence(chat, first, evidence.id);
  const again: any = await projects.execute(chat, 'read_project_file', { path: path.join(root, 'pages.txt'), start: 1, end: 291 }, controller.signal);
  expect(again.readReuse?.kind).toBe('validated-cache');
  expect(again.readReuse.originEvidenceId).toBe(evidence.id);
  expect(again.content).toBe(first.content);
  expect(again.endLine).toBe(200);
  expect(again.nextStartLine).toBe(201);
  expect(again.revision).not.toBe(first.revision);
  const patch = { path: 'pages.txt', revision: again.revision, oldText: 'line 1\n', newText: 'changed\n' };
  await projects.execute(chat, 'patch_project_file', patch, controller.signal);
  await expect(projects.execute(chat, 'patch_project_file', patch, controller.signal)).rejects.toThrow();
  expect((await fs.readFile(path.join(root, 'pages.txt'), 'utf8')).startsWith('changed\n')).toBe(true);
});

it('invalidates cached pages after external edits even with restored timestamps and refuses deleted targets', async () => {
  const { root, chat, projects, controller } = await fixture();
  const file = path.join(root, 'note.txt'); const before = await fs.stat(file);
  const read = () => projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal) as Promise<any>;
  await read(); expect((await read()).readReuse?.kind).toBe('validated-cache');
  await fs.writeFile(file, 'new'); await fs.utimes(file, before.atime, before.mtime);
  const changed = await read(); expect(changed.content).toContain('new'); expect(changed.readReuse).toBeUndefined();
  await fs.unlink(file); await expect(read()).rejects.toThrow();
});

it('isolates cached results by worker and invalidates them on permission changes', async () => {
  const { chat, projects, controller, store, project } = await fixture(3);
  const read = (owner: ChatThread) => projects.execute(owner, 'read_project_file', { path: 'note.txt' }, controller.signal) as Promise<any>;
  await read(chat); expect((await read(chat)).readReuse?.kind).toBe('validated-cache');
  const child = { ...chat, id: randomUUID(), messages: [] };
  await projects.prepareWorker(child, chat, projects.getWorkspace(chat), { ownedPaths: ['note.txt'], readOnly: false });
  expect((await read(child)).readReuse).toBeUndefined();
  expect((await read(child)).readReuse?.kind).toBe('validated-cache');
  store.saveProject({ ...project, permissionMode: 1, policyRevision: 2 }); projects.invalidate(project.id);
  expect((await read(chat)).readReuse).toBeUndefined();
  expect((await read(child)).readReuse).toBeUndefined();
  projects.releaseWorker(child);
});

it('mints usable cached revisions after older revision tokens have been evicted', async () => {
  const { chat, projects, controller, root } = await fixture(3);
  const first: any = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
  let latest: any;
  for (let i = 0; i < 1001; i++) latest = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
  expect(latest.readReuse?.kind).toBe('validated-cache');
  await expect(projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: first.revision, oldText: 'old', newText: 'new' }, controller.signal)).rejects.toThrow();
  await projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: latest.revision, oldText: 'old', newText: 'new' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('new');
}, 30000);

it('pages static catalog keys through the authorized read tool and returns the file revision', async () => {
  const { root, chat, projects, controller } = await fixture();
  await fs.writeFile(path.join(root, 'gamesinfo.js'), 'const games = {A: {description: "old"}, B: {description: "keep"}};');
  expect(projectTools.some(tool => tool.function.name === 'list_project_records')).toBe(true);
  const first: any = await projects.execute(chat, 'list_project_records', { path: 'gamesinfo.js', variable: 'games', limit: 1 }, controller.signal);
  expect(first).toMatchObject({ keys: ['A'], totalRecords: 2, nextOffset: 1 });
  expect(first.revision).toEqual(expect.any(String));
  const second: any = await projects.execute(chat, 'list_project_records', { path: 'gamesinfo.js', variable: 'games', offset: first.nextOffset }, controller.signal);
  expect(second).toMatchObject({ keys: ['B'], totalRecords: 2, nextOffset: null, hash: first.hash });
});
// Full project tool schemas count toward the context budget as well as messages.
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 32000 };
function service(store: Store, provider: ModelProvider, projects: ProjectTools) {
  const runtime = projectTestRuntime(provider);
  const workers = new ProjectWorkers(store, provider, runtime, projects, new ProjectWorktreeService(path.join(path.dirname(store.projects()[0].path), 'worker-fixtures')), () => {});
  return new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime, workers);
}
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
  cleanups.push(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = { id: randomUUID(), path: root, name: 'Fixture', permissionMode: mode, policyRevision: 1 };
  store.saveProject(project);
  store.saveSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: null, subagentModel: null });
  const chat: ChatThread = { id: randomUUID(), projectId: project.id, title: 'Project', profile, messages: [], status: 'idle', updatedAt: Date.now() };
  store.saveChat(chat);
  const approvals = new ChatApprovals(() => {
    if (mode === 3) for (const request of approvals.snapshot()) if (request.kind === 'command') approvals.answer(request.id, true);
  });
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'workspaces')));
  const controller = new AbortController();
  await projects.prepare(chat, controller.signal);
  return { directory, root, store, project, chat, approvals, projects, controller };
}

it('automatically confines read-only commands and reviews explicit workspace writes in read-only mode', async () => {
  const { directory, root, store, chat, approvals, controller } = await fixture(1);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ok', confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'readonly-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  await tools.execute(chat, 'run_project_process', { executable: 'python.exe', args: ['--version'] }, controller.signal);
  expect(approvals.snapshot()).toEqual([]);
  expect(execute).toHaveBeenNthCalledWith(1, expect.objectContaining({ confined: true, writableRoots: [] }), controller.signal);
  const pending = tools.execute(chat, 'run_project_command', { command: 'npm ci --offline', filesystemAccess: 'workspace-write' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(execute).toHaveBeenCalledTimes(1);
  approvals.answer(approvals.snapshot()[0].id, true);
  await pending;
  expect(execute).toHaveBeenNthCalledWith(2, expect.objectContaining({ writableRoots: [root] }), controller.signal);
});

it('requires a read-only edit approval and leaves the file unchanged on denial', async () => {
  const { root, chat, projects, approvals, controller } = await fixture(1);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
  const pending = projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: read.revision, oldText: 'old', newText: 'new' }, controller.signal);
  const denied = expect(pending).rejects.toThrow(/denied/i);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
  approvals.answer(approvals.snapshot()[0].id, false);
  await denied;
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it.each([2, 3] as const)('does not review executable names or offline installations in mode %s', async mode => {
  const { directory, store, chat, controller } = await fixture(mode);
  const approvals = new ChatApprovals(() => {});
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ok', confined: mode !== 3 }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'automatic-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  for (const command of ['python.exe --version', 'npm ci --offline', 'npx --offline test-tool']) {
    await tools.execute(chat, 'run_project_command', { command }, controller.signal);
  }
  expect(approvals.snapshot()).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(3);
});

it('requires an actual decision for worker networking even when the parent has full access', async () => {
  const { directory, store, chat, controller } = await fixture(3);
  const approvals = new ChatApprovals(() => {}, () => true);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ok', confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'worker-network-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  const child = { ...chat, id: randomUUID() };
  await tools.prepareWorker(child, chat, tools.getWorkspace(chat), { ownedPaths: ['note.txt'], readOnly: false });
  const pending = tools.execute(child, 'run_project_command', { command: 'node -v', network: 'allow' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(execute).not.toHaveBeenCalled();
  approvals.answer(approvals.snapshot()[0].id, true);
  await pending;
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ confined: true, network: 'allow' }), controller.signal);
});

it.each([2, 3] as const)('reviews network grants only in restricted mode %s', async mode => {
  const { directory, store, chat, controller } = await fixture(mode);
  const approvals = new ChatApprovals(() => {});
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ok', confined: mode !== 3 }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'network-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  const pending = tools.execute(chat, 'run_project_command', { command: 'npm ci', network: 'allow' }, controller.signal);
  if (mode === 2) {
    await expect.poll(() => approvals.snapshot().length).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    approvals.answer(approvals.snapshot()[0].id, true);
  }
  await pending;
  expect(approvals.snapshot()).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('blocks a task-scoped launch whose script is too large to inspect', async () => {
  const { directory, root, store, chat, approvals, controller } = await fixture(3);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'must not run', confined: false }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'scope-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  chat.projectHandoff = newHandoff(undefined, 'Fix a test');
  chat.projectHandoff.taskPolicy = beginProjectRequest(undefined, 'Fix a test', randomUUID());
  await fs.writeFile(path.join(root, 'large.cmd'), 'rem padding\n'.repeat(50000) + '\nwinget install Python.Python');
  await expect(tools.execute(chat, 'run_project_command', { command: 'large.cmd', purpose: 'test' }, controller.signal)).rejects.toMatchObject({ code: 'TASK_SCOPE_INSPECTION_INCOMPLETE' });
  expect(execute).not.toHaveBeenCalled();
});

it.each(['.agents/skills/config.txt', 'config/skills/config.txt'])('reviews canonical protected metadata through %s', async filename => {
  const { root, projects, chat, approvals, controller } = await fixture(2);
  await fs.mkdir(path.join(root, 'config', 'skills'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'skills', 'config.txt'), 'old');
  await fs.symlink(path.join(root, 'config'), path.join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  const read: any = await projects.execute(chat, 'read_project_file', { path: filename }, controller.signal);
  const pending = projects.execute(chat, 'patch_project_file', { path: filename, revision: read.revision, oldText: 'old', newText: 'new' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(await fs.readFile(path.join(root, 'config', 'skills', 'config.txt'), 'utf8')).toBe('old');
  approvals.answer(approvals.snapshot()[0].id, true);
  await pending;
  expect(await fs.readFile(path.join(root, 'config', 'skills', 'config.txt'), 'utf8')).toBe('new');
});

it('delivers complete programming workflows without skill tool calls, even with large repository context and on resume', async () => {
  const { root, store, chat, projects } = await fixture();
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Repository conventions. '.repeat(1000));
  await fs.mkdir(path.join(root, '.mercury/architecture'), { recursive: true });
  await fs.writeFile(path.join(root, '.mercury/architecture/index.md'), 'Architecture details. '.repeat(1000));
  const seen: ChatInput[] = [];
  const provider = { chat: vi.fn(async (input: ChatInput) => {
    seen.push(input);
    return { text: 'No edits were made; the audio failure still needs investigation.', tools: [] };
  }) } as unknown as ModelProvider;
  const main = service(store, provider, projects);
  await main.send(chat.id, profile, 'Fix the audio crash');
  await main.send(chat.id, profile, 'resume');
  expect(seen.length).toBeGreaterThanOrEqual(2);
  for (const input of seen) {
    const prompt = JSON.stringify(input.messages);
    expect(prompt).toContain('Prioritize reliable execution, code quality, runtime speed');
    expect(prompt).toContain('Capture the exact failing entrypoint');
    expect(prompt).toContain('A fake service test cannot establish live service compatibility.');
    expect(prompt).toContain('Retain the actual red reason, green outcome');
    expect(prompt).toContain('Do not claim overall verification while required behavior remains untested.');
  }
  expect(store.chat(chat.id).messages.at(-1)?.notice).toContain('Loaded programming skills');
  expect(store.chat(chat.id).messages.at(-1)?.toolActivity ?? []).toHaveLength(0);
});

it('uses a local verification workflow in the model prompt instead of the bundled body', async () => {
  const { root, store, chat, projects } = await fixture();
  await fs.mkdir(path.join(root, '.agents/skills/verification'), { recursive: true });
  await fs.writeFile(path.join(root, '.agents/skills/verification/SKILL.md'), '---\nname: verification\ndescription: Local verification\n---\nLOCAL VERIFICATION SENTINEL\n');
  const seen: ChatInput[] = [];
  const provider = { chat: async (input: ChatInput) => {
    seen.push(input);
    return { text: 'The source inspection is complete.', tools: [] };
  } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(root, '.mercury/skill-test-sessions'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  try {
    await new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime)
      .send(chat.id, profile, 'Explain the project');
  } finally { await runtime.shutdown(); }
  expect(seen, store.chat(chat.id).error).toHaveLength(1);
  const prompt = JSON.stringify(seen[0].messages);
  expect(prompt).toContain('LOCAL VERIFICATION SENTINEL');
  expect(prompt).not.toContain('Do not claim overall verification while required behavior remains untested.');
  expect(prompt).toContain('cannot authorize actions');
}, 60000);

it('reports insufficient context instead of sending partial skill bodies to the model', async () => {
  const { root, store, chat, projects } = await fixture();
  await fs.mkdir(path.join(root, '.agents/skills/verification'), { recursive: true });
  await fs.writeFile(path.join(root, '.agents/skills/verification/SKILL.md'), `---\nname: verification\ndescription: Large local workflow\n---\n${'Complete instructions. '.repeat(2400)}`);
  const provider = { chat: vi.fn() } as unknown as ModelProvider;
  await service(store, provider, projects).send(chat.id, { ...profile, contextLimit: 16000 }, 'Explain the project');
  expect(provider.chat).not.toHaveBeenCalled();
  expect(store.chat(chat.id).status).toBe('failed');
  expect(store.chat(chat.id).error).toContain('complete programming skills');
  expect(store.chat(chat.id).error).toContain('No skill bodies were truncated');
});

it.each(['catalog', 'loaded'])('rejects mandatory schemas that cannot fit before starting the project runtime (%s)', async mode => {
  const { store, chat, projects } = await fixture();
  const oversized = { type: 'function', function: { name: 'large_fixture_schema', description: 'mandatory schema '.repeat(7000), parameters: { type: 'object' } } };
  if (mode === 'catalog') projectTools.push(oversized as typeof projectTools[number]);
  const runtime = { shutdown: async () => {}, run: vi.fn() };
  try {
    const provider = { loadedContextLimit: async () => mode === 'loaded' ? 4096 : null } as unknown as ModelProvider;
    await new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime)
      .send(chat.id, profile, 'Explain the project');
    expect(runtime.run).not.toHaveBeenCalled();
    expect(store.chat(chat.id).status).toBe('failed');
    expect(store.chat(chat.id).error).toMatch(/tool schemas|tool catalog/);
    expect(store.chat(chat.id).error).toContain('No skill bodies were truncated');
  } finally { if (mode === 'catalog') projectTools.splice(projectTools.indexOf(oversized as typeof projectTools[number]), 1); }
});

it.each(['history', 'usage'])('automatically compacts a project chat while preserving requests, task failures and saved history (%s)', async (trigger) => {
  const { store, chat, projects } = await fixture();
  chat.messages = [
    { id: randomUUID(), role: 'user', content: 'Fix audio. Keep the selected endpoint and never change my model.' },
    ...Array.from({ length: trigger === 'history' ? 12 : 0 }, (_, index) => ({ id: randomUUID(), role: 'assistant' as const, content: `OLD EXPLANATION ${index}: ${'verbose speculation. '.repeat(300)}` })),
  ];
  chat.projectHandoff = newHandoff(undefined, 'Fix audio while preserving the selected endpoint');
  chat.projectHandoff.requirements = [{ id: 'audio', text: 'Audio renders successfully', status: 'failed', verification: 'command', evidenceIds: ['audio-evidence'] }];
  chat.projectHandoff.blocker = { tool: 'run_project_process', target: 'subtitles.py', code: 'AUDIO_SHAPE', message: 'Stereo shape mismatch', nextAction: 'Test real audio mixing', at: Date.now() };
  chat.projectRuntime = { runtime: 'claude-agent-sdk', version: 'fixture', identity: chat.id, sessionId: 'old-large-session', status: 'completed' };
  if (trigger === 'usage') chat.projectContextTokens = Math.ceil(profile.contextLimit * .9);
  store.saveChat(chat);
  const original = structuredClone(chat.messages);
  const seen: ChatInput[] = [];
  const provider = { chat: async (input: ChatInput) => {
    seen.push(input);
    return { text: 'The audio shape failure remains unresolved. No files were changed.', tools: [] };
  } } as unknown as ModelProvider;
  const runtime = projectTestRuntime(provider);
  const run = vi.spyOn(runtime, 'run');
  await new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime)
    .send(chat.id, profile, 'Explain the remaining problem without editing');
  expect(seen.length).toBeGreaterThan(0);
  const prompt = JSON.stringify(seen[0].messages);
  expect(prompt.length).toBeLessThan(48000);
  expect(prompt).toContain('never change my model');
  expect(prompt).toContain('Stereo shape mismatch');
  expect(prompt).toContain('audio-evidence');
  expect(prompt).toContain('Explain the remaining problem without editing');
  expect(prompt).toContain('Prioritize reliable execution, code quality');
  expect(run.mock.calls[0][0].session).toBeUndefined();
  expect(store.chat(chat.id).messages.slice(0, original.length)).toEqual(original);
  expect(store.chat(chat.id).messages.at(-1)?.notice).toContain('Compacted');
  expect(store.chat(chat.id).projectHandoff?.requirements[0].status).toBe('failed');
});

it.each(['reported', 'estimated', 'loaded', 'turns'])('rolls over an active response and resumes from saved evidence (%s)', async trigger => {
  const { store, chat, projects } = await fixture();
  const runs: any[] = [];
  const states: string[] = [];
  const runtime = { shutdown: async () => {}, run: vi.fn(async (input: any) => {
    runs.push(input);
    const session = { runtime: 'claude-agent-sdk' as const, version: 'fixture', identity: 'fixture', sessionId: String(runs.length), status: 'completed' as const };
    input.onSession(session);
    if (runs.length === 1) {
      await input.execute('read_project_file', { path: 'note.txt' });
      if (trigger === 'turns') throw new ProjectContextRollover('turns');
      const limit = input.profile.contextLimit;
      input.onUsage({ input: limit * .9 - 1, output: 0 });
      input.onContextCheckpoint(100); // One token below 90% must keep working.
      if (trigger !== 'estimated') input.onUsage({ input: limit * .9 - 400, output: 400 });
      input.onContextCheckpoint(trigger === 'estimated' ? limit * .9 : 100);
      throw new Error('Checkpoint failed to pause the run');
    }
    expect(input.session).toBeUndefined();
    expect(input.context).toContain('AUTO-COMPACTION HANDOFF');
    expect(input.context).toContain('read_project_file');
    expect(input.context).toContain('Do not replay completed');
    input.onText('The saved file contains old. No edits were made.');
    return { text: 'The saved file contains old. No edits were made.', session };
  }) };
  const provider = { loadedContextLimit: async () => trigger === 'loaded' ? 24000 : null } as unknown as ModelProvider;
  await new ChatService(store, provider, value => {
    const phase = value.messages.at(-1)?.compaction?.phase;
    if (phase) states.push(phase);
  }, () => false, undefined, undefined, projects, runtime).send(chat.id, profile, 'Read note.txt and explain its contents');
  expect(runs).toHaveLength(2);
  expect(runs[0].profile.contextLimit).toBe(trigger === 'loaded' ? 24000 : profile.contextLimit);
  expect(states).toContain('compacting');
  expect(states).toContain('resuming');
  expect(store.chat(chat.id).status).toBe('idle');
  expect(store.chat(chat.id).messages.filter(item => item.role === 'user')).toHaveLength(1);
  expect(store.chat(chat.id).messages.at(-1)?.toolActivity).toHaveLength(1);
});

it('automatically resumes a real SDK project run at 90% without replaying the completed read', async () => {
  const { store, chat, projects, directory } = await fixture();
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    if (JSON.stringify(input.messages).includes('AUTO-COMPACTION HANDOFF')) return { text: 'The saved file contains old. No edits were needed.', tools: [] };
    return { text: '', tools: [{ id: 'read-once', name: 'mcp__mercury__read_project_file', arguments: { path: 'note.txt' } }], usage: { input: profile.contextLimit * .9, output: 1 } };
  } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(directory, 'rollover-sdk'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  cleanups.push(() => runtime.shutdown());
  await new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime).send(chat.id, profile, 'Read note.txt and explain its contents');
  const saved = store.chat(chat.id);
  expect(saved.status, saved.error).toBe('idle');
  expect(calls).toBe(2);
  expect(saved.messages.at(-1)?.toolActivity).toHaveLength(1);
  expect(saved.messages.at(-1)?.compaction?.phase).toBe('completed');
  expect(saved.messages.at(-1)?.compaction?.handoff).toContain('read_project_file');
}, 60000);

it.each(['stop', 'oversized', 'helpers', 'turns'])('does not loop or restart when compaction is %s', async mode => {
  const { store, chat, projects } = await fixture();
  const runtime = { shutdown: async () => {}, run: vi.fn(async (input: any) => {
    if (mode === 'turns') throw new ProjectContextRollover('turns');
    if (mode === 'helpers') input.onContextCheckpoint(0); // Small SDK helper requests must not reset the restart guard.
    input.onContextCheckpoint(profile.contextLimit);
    throw new Error('Oversized checkpoint was ignored');
  }) };
  const main = new ChatService(store, {} as ModelProvider, value => {
    if (mode === 'stop' && value.messages.at(-1)?.compaction?.phase === 'compacting') main.stop(chat.id);
  }, () => false, undefined, undefined, projects, runtime);
  await main.send(chat.id, profile, 'Explain note.txt');
  expect(runtime.run).toHaveBeenCalledTimes(mode === 'stop' ? 1 : 2);
  expect(store.chat(chat.id).status).toBe(mode === 'stop' ? 'stopped' : 'failed');
  expect(store.chat(chat.id).messages.at(-1)?.compaction?.phase).toBe('failed');
  if (mode !== 'stop') expect(store.chat(chat.id).error).toContain(mode === 'turns' ? 'without further tool progress' : 'still exceeds 90%');
});

it('keeps diagnostics read-only unless the user approves a command outside isolation', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async (_request: import('./project-execution').ProjectExecutionRequest) => ({ exitCode: 0, output: 'inspected', confined: true }));
  let available = true;
  const execution = { probe: async () => ({ available }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'scope-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  chat.projectHandoff = newHandoff(undefined, 'Inspect');
  for (const request of ['Do not edit; inspect only', 'Debug and fix the server', 'Install pytest using existing Python']) {
    chat.projectHandoff.taskPolicy = beginProjectRequest(undefined, request, randomUUID());
    await tools.execute(chat, 'run_project_command', { command: 'dir', purpose: 'test' }, controller.signal);
    expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({ confined: true, writableRoots: [] });
    available = false;
    const blocked = tools.execute(chat, 'run_project_command', { command: 'dir', purpose: 'test' }, controller.signal);
    const denied = expect(blocked).rejects.toThrow('denied');
    await expect.poll(() => approvals.snapshot().length).toBe(1);
    expect(approvals.snapshot()[0].details).toContain('including read-only diagnostic limits');
    approvals.answer(approvals.snapshot()[0].id, false);
    await denied;
    approvals.beginTurn(chat.id);
    available = true;
  }
  chat.projectHandoff.taskPolicy = beginProjectRequest(undefined, 'Read main.py', randomUUID());
  await expect(tools.execute(chat, 'download_project_asset', { url: 'https://example.invalid/file', destination: 'note.txt', format: 'binary', maxBytes: 100 }, controller.signal)).rejects.toMatchObject({ code: 'TASK_SCOPE_EDIT_BLOCKED' });
  await expect(tools.pluginPolicy(chat).authorize('opaque operation', null, controller.signal)).rejects.toMatchObject({ code: 'TASK_SCOPE_PLUGIN_BLOCKED' });
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it.each([1, 2, 3] as const)('runs project executables automatically with mode %i enforced', async mode => {
  const { root, directory, store, chat, approvals, controller } = await fixture(mode);
  const executable = path.join(root, 'python.exe');
  await fs.writeFile(executable, 'fixture interpreter');
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'tests passed', confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'exe-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  chat.projectHandoff = newHandoff(undefined, 'Debug and fix empty output');
  chat.projectHandoff.taskPolicy = beginProjectRequest(undefined, 'Debug and fix empty output', randomUUID());
  chat.projectHandoff.taskPolicy.diagnosis = { symptom: 'empty output', hypothesis: 'response field mismatch', testToConfirm: 'probe original endpoint', proposedChange: 'parse actual content', affectedPaths: ['note.txt'], evidenceIds: ['unit-policy-tested'], at: Date.now(), revision: 0, executionConfirmed: true };
  const review = vi.spyOn(approvals, 'request');
  review.mockRejectedValue(new Error('Unexpected command approval'));
  for (const [name, args] of [
    ['run_project_process', { executable, args: ['-m', 'pytest'], purpose: 'test' }],
    ['run_project_command', { command: 'python.exe -m pytest', purpose: 'test' }],
  ] as const) {
    const pending = tools.execute(chat, name, args, controller.signal);
    await pending;
  }
  expect(execute).toHaveBeenCalledTimes(2);
  expect(review).not.toHaveBeenCalled();
  if (mode === 1) expect(execute).toHaveBeenNthCalledWith(1, expect.objectContaining({ writableRoots: [], confined: true }), controller.signal);
});

it('does not run unbounded debugging commands or write an alternative backend after denied scope review', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ran', confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'diagnosed-workspaces')), undefined, { execution });
  await tools.prepare(chat, controller.signal);
  chat.projectHandoff = newHandoff(undefined, 'Debug and fix empty output');
  chat.projectHandoff.taskPolicy = beginProjectRequest(undefined, 'Debug and fix empty output', randomUUID());
  chat.projectHandoff.taskPolicy.diagnosis = { symptom: 'empty output', hypothesis: 'response field mismatch', testToConfirm: 'probe original endpoint', proposedChange: 'parse actual content', affectedPaths: ['note.txt'], evidenceIds: ['unit-policy-tested'], at: Date.now(), revision: 0, executionConfirmed: true };
  for (const [name, args] of [
    ['run_project_command', { command: 'node -e "performChanges()"', purpose: 'other' }],
    ['edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'from gpt4all import GPT4All' }],
  ] as const) {
    approvals.beginTurn(chat.id); // Independent user turns; denial must not trigger another prompt in the same turn.
    const outcome = tools.execute(chat, name, args, controller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await expect.poll(() => approvals.snapshot().length).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    approvals.answer(approvals.snapshot()[0].id, false);
    expect((await outcome).error.message).toContain('denied');
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
  }
});

it('retains explicit task entrypoints through preparation and unrelated test edits', async () => {
  const { root, projects, chat, controller } = await fixture(3);
  chat.projectHandoff = newHandoff(undefined, 'Implement feature');
  await fs.writeFile(path.join(root, 'main.py'), 'print("native")');
  await fs.writeFile(path.join(root, 'index.html'), '<script>import "onnxruntime-web"</script>');
  await projects.execute(chat, 'inspect_project_target', { entryPoint: 'main.py' }, controller.signal);
  await projects.prepare(chat, controller.signal);
  expect(chat.projectHandoff.requiresModelVerification).toBe(false);
  await projects.execute(chat, 'inspect_project_target', { entryPoint: 'index.html' }, controller.signal);
  await projects.execute(chat, 'edit_project_file', { path: 'tests/test_model.py', content: '# browser app smoke harness' }, controller.signal);
  expect(chat.projectHandoff.requiresModelVerification).toBe(true);
  expect(chat.projectHandoff.verificationTarget?.entryPoint).toBe('index.html');
  await fs.unlink(path.join(root, 'index.html'));
  await expect(projects.prepare(chat, controller.signal)).resolves.toContain('PROJECT CODING CONTEXT');
  expect(chat.projectHandoff.verificationTarget?.kind).toBe('unknown');
  expect(chat.projectHandoff.requiresModelVerification).toBe(true);
  await projects.execute(chat, 'inspect_project_target', { entryPoint: 'main.py' }, controller.signal);
  expect(chat.projectHandoff.requiresModelVerification).toBe(false);
});

it('reads and edits the assigned project with hashes and preserves newer user content', async () => {
  const { projects, chat, root, controller } = await fixture();
  const read = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal) as { hash: string };
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: read.hash, content: 'new' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('new');
  await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: read.hash, content: 'stale' }, controller.signal)).rejects.toThrow(/changed/);
});

it('edits a named catalog record without copying source blocks, preserves neighbors and rejects stale writes', async () => {
  const { projects, chat, root, controller } = await fixture();
  const source = '// catalog\r\nconst games = {\r\n  "Game A": {name: "A", description: `Old`, url: "a.html", tags: ["action", "arcade"]},\r\n  B: {description: "Keep"}\r\n};\r\n' + '// padding\r\n'.repeat(50000);
  await fs.writeFile(path.join(root, 'catalog.js'), source);
  const read: any = await projects.execute(chat, 'read_project_record', { path: 'catalog.js', variable: 'games', key: 'Game A' }, controller.signal);
  expect(read.fields).toEqual({ name: 'A', description: 'Old', url: 'a.html', tags: ['action', 'arcade'] });
  const changed: any = await projects.execute(chat, 'patch_project_record', { path: 'catalog.js', variable: 'games', key: 'Game A', fields: { description: 'A "better" game', metaDescription: 'New SEO' } }, controller.signal);
  const after = await fs.readFile(path.join(root, 'catalog.js'), 'utf8');
  expect(after).toContain('description: "A \\"better\\" game"');
  expect(after).toContain('"metaDescription": "New SEO"');
  expect(after.slice(after.indexOf('  B:'))).toBe(source.slice(source.indexOf('  B:')));
  // With the new implementation, patchRecord always reads current file state (no stale write check needed)
  expect(changed.hash).not.toBe(read.hash);
  chat.projectHandoff = newHandoff(undefined, 'Catalog edit');
  chat.projectHandoff.snapshots = [{ path: 'catalog.js', hash: changed.hash }];
  chat.projectHandoff.requirements = [{ text: 'Catalog edited', status: 'completed', completionNote: 'Edited', verification: 'inspection', evidenceIds: [] }];
  await projects.prepare(chat, controller.signal);
  expect(chat.projectHandoff.requirements[0].status).toBe('completed');
});

it('rejects ambiguous or executable catalog records without executing source or writing', async () => {
  const { projects, chat, root, controller } = await fixture();
  for (const source of ['const games = { A: {description: sideEffect()} };', 'const games = { A: {description: "one"}, A: {description: "two"} };']) {
    await fs.writeFile(path.join(root, 'catalog.js'), source);
    await expect(projects.execute(chat, 'read_project_record', { path: 'catalog.js', variable: 'games', key: 'A' }, controller.signal)).rejects.toThrow(/static|ambiguous/i);
    expect(await fs.readFile(path.join(root, 'catalog.js'), 'utf8')).toBe(source);
  }
});

it('resumes batch research through real tools while keeping integration main-only and revision checked', async () => {
  const { projects, chat, root, controller, store, approvals, directory } = await fixture();
  expect(projects.toolsForWorker(false).some(tool => /project_batch|patch_project_record/.test(tool.function.name))).toBe(false);
  const first: any = await projects.execute(chat, 'read_project_batch', { batchId: 'seo' }, controller.signal);
  const ready = { id: 'A', status: 'ready', research: 'Research notes', proposal: 'New description', sources: ['https://example.com/a'] };
  await projects.execute(chat, 'update_project_batch', { batchId: 'seo', expectedRevision: first.revision, items: [ready] }, controller.signal);
  expect(await projects.execute(chat, 'list_project_batches', {}, controller.signal)).toMatchObject({ batches: [{ batchId: 'seo', revision: 1, itemCount: 1 }] });
  await fs.writeFile(path.join(root, 'catalog.js'), 'const games = {A: {description: "old", tags: ["action"]}};');
  const read: any = await projects.execute(chat, 'read_project_record', { path: 'catalog.js', variable: 'games', key: 'A' }, controller.signal);
  await expect(projects.execute(chat, 'update_project_batch', { batchId: 'seo', expectedRevision: 1, items: [{ id: 'A', status: 'integrated', integratedFiles: [{ path: 'catalog.js', hash: read.hash }] }] }, controller.signal)).rejects.toThrow(/successful.*(?:edit|mutation)|receipt/i);
  const edit: any = await projects.execute(chat, 'patch_project_record', { path: 'catalog.js', variable: 'games', key: 'A', revision: read.revision, fields: { description: 'New description' } }, controller.signal);
  chat.messages.push({ id: randomUUID(), role: 'assistant', content: 'Patched catalog', sourceEvidence: [sourceEvidence('patch_project_record', { path: 'catalog.js', variable: 'games', key: 'A' }, edit)] });
  store.saveChat(chat);
  const restarted = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'workspaces')));
  const restoredChat = store.chat(chat.id);
  await restarted.prepare(restoredChat, controller.signal);
  await restarted.execute(restoredChat, 'update_project_batch', { batchId: 'seo', expectedRevision: 1, items: [{ id: 'A', status: 'integrated', integratedFiles: [{ path: 'catalog.js', hash: edit.hash }] }] }, controller.signal);
  expect(await projects.execute(chat, 'read_project_batch', { batchId: 'seo', itemId: 'A' }, controller.signal)).toMatchObject({ revision: 2, item: { status: 'integrated', research: ready.research } });
  await expect(projects.execute(chat, 'update_project_batch', { batchId: 'seo', expectedRevision: 0, items: [ready] }, controller.signal)).rejects.toMatchObject({ code: 'BATCH_STALE_REVISION' });
  controller.abort();
  await expect(projects.execute(chat, 'patch_project_record', { path: 'catalog.js', variable: 'games', key: 'A', revision: edit.revision, fields: { description: 'cancelled' } }, controller.signal)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'catalog.js'), 'utf8')).toContain('New description');
});

it('patches a large HTML file with an opaque revision and rejects stale or ambiguous edits', async () => {
  const { projects, chat, root, controller } = await fixture();
  const source = '<html>\n' + Array.from({ length: 527 }, (_, i) => `<p id="p${i}">你好 ${i}</p>`).join('\n') + '\n</html>';
  await fs.writeFile(path.join(root, 'index.html'), source);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'index.html' }, controller.signal);
  expect(read).toMatchObject({ totalLines: 529, startLine: 1, endLine: 200, truncated: true, nextStartLine: 201 });
  const second: any = await projects.execute(chat, 'read_project_file', { path: 'index.html', start: 201 }, controller.signal);
  expect(second.endLine).toBe(400);
  await expect(projects.execute(chat, 'edit_project_file', { path: 'index.html', revision: read.revision, content: 'const POSES = {};' }, controller.signal)).rejects.toThrow('half');
  await projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: read.revision, oldText: '你好 250', newText: 'Hello 世界' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'index.html'), 'utf8')).toBe(source.replace('你好 250', 'Hello 世界'));
  await expect(projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: read.revision, oldText: '你好 1', newText: 'changed' }, controller.signal)).rejects.toThrow('changed');
  const fresh: any = await projects.execute(chat, 'read_project_file', { path: 'index.html' }, controller.signal);
  await expect(projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: fresh.revision, oldText: '<p', newText: '<div' }, controller.signal)).rejects.toThrow('exactly one');
  controller.abort();
  await expect(projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: fresh.revision, oldText: 'Hello 世界', newText: 'cancelled' }, controller.signal)).rejects.toThrow();
});

it('binds read revisions to the chat and file and allows intentional full rewrites', async () => {
  const { projects, chat, root, controller } = await fixture();
  await fs.writeFile(path.join(root, 'large.txt'), 'original '.repeat(200));
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'large.txt' }, controller.signal);
  await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', revision: read.revision, content: 'wrong file' }, controller.signal)).rejects.toThrow('this file/chat');
  await projects.execute(chat, 'edit_project_file', { path: 'large.txt', revision: read.revision, content: 'intentional', replacementIntent: true }, controller.signal);
  expect(await fs.readFile(path.join(root, 'large.txt'), 'utf8')).toBe('intentional');
});

it('patches logical multiline text in Windows files without changing surrounding line endings', async () => {
  const { projects, chat, root, controller } = await fixture();
  const source = 'before\r\nconst label = "你好";\r\nconst count = 1;\r\nafter\r\n';
  await fs.writeFile(path.join(root, 'windows.js'), source);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'windows.js' }, controller.signal);
  await projects.execute(chat, 'patch_project_file', { path: 'windows.js', revision: read.revision, oldText: 'const label = "你好";\nconst count = 1;', newText: 'const label = "世界";\nconst count = 2;' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'windows.js'), 'utf8')).toBe('before\r\nconst label = "世界";\r\nconst count = 2;\r\nafter\r\n');
});

it('stops a project reread loop after one recovery and preserves an actionable handoff', async () => {
  const { store, project, projects, directory } = await fixture();
  const execute = vi.spyOn(projects, 'execute');
  const completed = vi.fn(); let calls = 0;
  const provider = { chat: async () => { calls++; return { text: 'Let me read the source again.', tools: [{ id: `read-${calls}`, name: 'mcp__mercury__read_project_file', arguments: { path: 'note.txt' } }] }; } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(directory, 'loop-sessions'), { executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') });
  cleanups.push(() => runtime.shutdown());
  const service = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime, undefined, completed);
  const id = await service.send(null, profile, 'Fix the project', [], undefined, project.id);
  const saved = store.chat(id);
  expect(calls).toBe(17); expect(saved.status).toBe('idle'); expect(saved.error).toBeUndefined();
  const response = saved.messages.at(-1)!;
  expect(response.delivery?.status).toBe('blocked'); expect(response.content).toContain('Next action:');
  expect(execute.mock.calls.filter(([, name]) => name === 'read_project_file')).toHaveLength(17);
  expect(response.sourceEvidence?.filter(item => item.tool === 'read_project_file').slice(1).every(item => JSON.parse(item.result).readReuse?.kind === 'validated-cache')).toBe(true);
  expect(saved.messages.at(-1)?.metrics?.recoveries).toBe(1);
  expect(saved.projectHandoff?.reads).toHaveLength(1); expect(saved.projectHandoff?.objective).toBe('Fix the project');
  expect(completed).not.toHaveBeenCalled();
}, 60000);

it('accounts for real SDK schema rejections and stops varied invalid arguments before any edit',async()=>{
  const {store,project,projects,directory,root}=await fixture();let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    calls++;
    const definition=(input.tools as any[]).find(item=>item.function.name==='mcp__mercury__patch_project_file');
    expect(JSON.stringify(definition)).toContain('expectedHash');
    return {text:'',tools:[{id:`bad-${calls}`,name:'mcp__mercury__patch_project_file',arguments:{path:'note.txt',revision:`invalid-${calls}`,oldText:'old',newText:'must not write'}}]};
  }} as unknown as ModelProvider;
  const runtime=new ClaudeProjectRuntime(provider,path.join(directory,'invalid-sdk'),{executablePath:path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')});cleanups.push(()=>runtime.shutdown());
  const chats=new ChatService(store,provider,()=>{},()=>false,undefined,undefined,projects,runtime);
  const id=await chats.send(null,profile,'Inspect the file',[],undefined,project.id);const saved=store.chat(id),reply=saved.messages.at(-1)!;
  expect(calls).toBe(6);expect(saved.status).toBe('stopped');expect(reply.toolActivity).toHaveLength(6);expect(reply.toolActivity!.every(item=>item.status==='failed')).toBe(true);
  expect(reply.sourceEvidence!.every(item=>JSON.parse(item.result).code==='INVALID_ARGUMENTS')).toBe(true);expect(reply.metrics?.recoveries).toBe(1);expect(reply.runtimeBuild).toBe(PROJECT_RUNTIME_BUILD);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
},60000);

it('returns invalid SDK tool arguments to the model without blocking an otherwise complete project answer',async()=>{
  const {store,project,projects,directory,root}=await fixture();let calls=0;
  const provider={chat:async()=>{
    calls++;
    return calls===1
      ? {text:'',tools:[{id:'bad-read',name:'mcp__mercury__read_project_file',arguments:{path:''}}]}
      : {text:'The project rundown is complete despite the unavailable optional read.',tools:[]};
  }} as unknown as ModelProvider;
  const runtime=new ClaudeProjectRuntime(provider,path.join(directory,'validation-recovery-sdk'),{executablePath:path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')});cleanups.push(()=>runtime.shutdown());
  const id=await new ChatService(store,provider,()=>{},()=>false,undefined,undefined,projects,runtime).send(null,profile,'Give me a project rundown',[],undefined,project.id);
  const reply=store.chat(id).messages.at(-1)!;
  expect(calls).toBe(2);expect(store.chat(id).status).toBe('idle');
  expect(reply.delivery?.status).toBe('completed');expect(reply.toolActivity?.[0]).toMatchObject({name:'read_project_file',status:'failed'});
  expect(reply.sourceEvidence?.[0].result).toContain('INVALID_ARGUMENTS');
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
},60000);

it('clears a persisted validation-only blocker before a successful project follow-up',async()=>{
  const {store,project,projects,directory}=await fixture();
  const first={chat:async()=>({text:'',tools:[{id:'bad-read',name:'mcp__mercury__read_project_file',arguments:{path:''}}]})} as unknown as ModelProvider;
  const runtime=new ClaudeProjectRuntime(first,path.join(directory,'validation-follow-up-sdk'),{executablePath:path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')});cleanups.push(()=>runtime.shutdown());
  const chats=new ChatService(store,first,()=>{},()=>false,undefined,undefined,projects,runtime);
  const id=await chats.send(null,profile,'Inspect the project',[],undefined,project.id);
  const persisted=store.chat(id);
  persisted.projectHandoff!.blocker={tool:'read_project_file',target:'.',code:'INVALID_ARGUMENTS',message:'Invalid tool arguments.',nextAction:'Retry with a valid path.',at:Date.now()};
  store.saveChat(persisted);
  const second={chat:async()=>({text:'The project is healthy and the rundown is complete.',tools:[]})} as unknown as ModelProvider;
  const continued=new ChatService(store,second,()=>{},()=>false,undefined,undefined,projects,projectTestRuntime(second));
  await continued.send(id,profile,'Give me the complete rundown now.');
  const reply=store.chat(id).messages.at(-1)!;
  expect(store.chat(id).status).toBe('idle');expect(store.chat(id).projectHandoff?.blocker).toBeUndefined();expect(reply.delivery?.status).toBe('completed');
},60000);

it('refuses a missing contract before touching the workspace',async()=>{
  const {store,project,projects,root}=await fixture();let calls=0;
  const provider={chat:async()=>++calls===1?{text:'',tools:[{id:'edit',name:'edit_project_file',arguments:{path:'note.txt',expectedHash:hash('old'),content:'should not write'}}]}:{text:'The contract must be recorded first.',tools:[]}} as unknown as ModelProvider;
  const id=await service(store,provider,projects).send(null,profile,'Update the project',[],undefined,project.id);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
  const reply=store.chat(id).messages.at(-1)!;expect(JSON.parse(reply.sourceEvidence![0].result).code).toBe('NEED_TASK_CONTRACT');
});

it('rejects a server command before dispatch when no task contract exists',async()=>{
  const {store,project,projects}=await fixture(3);let calls=0;
  const execute=vi.spyOn(projects,'execute');
  const provider={chat:async()=>++calls===1?{text:'',tools:[{id:'server',name:'start_project_server',arguments:{command:'write arbitrary files',port:3000}}]}:{text:'Work remains blocked.',tools:[]}} as unknown as ModelProvider;
  const id=await service(store,provider,projects).send(null,profile,'Start implementing the website',[],undefined,project.id);
  expect(execute).not.toHaveBeenCalled();
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.[0].result).toContain('NEED_TASK_CONTRACT');
  expect(store.chat(id).messages.at(-1)?.delivery?.status).toBe('blocked');
});

it('treats omitted edit preconditions as create-only without overwriting existing content', async () => {
  const { projects, chat, controller, root } = await fixture(3);
  await projects.execute(chat, 'edit_project_file', { path: 'new.txt', content: 'created' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('created');
  for (const expectedHash of [undefined, 'null'])
    await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash, content: 'overwrite' }, controller.signal)).rejects.toMatchObject({ code: 'CREATE_TARGET_EXISTS', message: expect.stringContaining('No file was changed or reverted') });
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it('diagnoses typography and escaped-text patch mismatches without fuzzy editing the file', async () => {
  const { projects, chat, controller, root } = await fixture(3);
  for (const [source, oldText, reason] of [["It’s saved", "It's saved", 'TYPOGRAPHIC_QUOTES'], ["join('\\n')", "join('\\\\n')", 'OVER_ESCAPED_BACKSLASHES'], ['          <button>Load</button>', '           <button>Load</button>', 'LINE_INDENTATION']]) {
    await fs.writeFile(path.join(root, 'note.txt'), source);
    const read: any = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
    await expect(projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: read.revision, oldText, newText: 'changed' }, controller.signal)).rejects.toMatchObject({ code: 'PATCH_NO_MATCH', details: { reason, sourceLine: 1, sourceExcerpt: source } });
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe(source);
  }
});

it('delivers project browser images without an ordinary-chat file store', async () => {
  const { store, project, projects } = await fixture(3);
  const image = { mimeType: 'image/jpeg', data: 'screenshot-fixture' };
  const capabilities = { beginTurn: () => {}, endTurn: async () => {}, handles: (name: string) => name === 'browser_screenshot', execute: async () => ({ url: 'https://example.org/', _browserImage: image }) } as any;
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (++calls === 1) return { text: '', tools: [{ id: 'shot', name: 'browser_screenshot', arguments: {} }] };
    const result = JSON.parse((input.messages.at(-1) as any).content);
    expect(result.error).toBeUndefined();
    expect(result._mercuryImages).toEqual([image]);
    return { text: 'Captured the page; no behavior verified yet.', tools: [] };
  } } as unknown as ModelProvider;
  const chatService = new ChatService(store, provider, () => {}, () => false, undefined, capabilities, projects, projectTestRuntime(provider));
  const id = await chatService.send(null, profile, 'Inspect this page', [], undefined, project.id);
  expect(store.chat(id).messages.at(-1)?.toolActivity?.[0].status).toBe('succeeded');
  expect(store.chat(id).messages.at(-1)?.files).toBeUndefined();
});

it('returns a fresh scoped revision after a write for safe chained patches', async () => {
  const { projects, chat, controller, root } = await fixture(3);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
  const first: any = await projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: read.revision, oldText: 'old', newText: 'first' }, controller.signal);
  expect(first.revision).not.toBe(read.revision);
  await projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: first.revision, oldText: 'first', newText: 'second' }, controller.signal);
  await expect(projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: first.revision, oldText: 'second', newText: 'stale' }, controller.signal)).rejects.toThrow('changed since');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('second');
});

it('retrieves the exact saved task contract without project notes or source rereads', async () => {
  const { store, project, projects } = await fixture(3);
  let calls = 0;
  const criterion = { text: 'Inspect the local project', status: 'not_run', verification: 'inspection', evidenceIds: [] };
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    if (calls === 1) return { text: '', tools: [{ id: 'contract', name: 'update_project_task', arguments: { requirements: [criterion], remaining: 'Inspect sources' } }] };
    if (calls === 2) {
      expect(input.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'read_project_task' }) })]));
      return { text: '', tools: [{ id: 'task', name: 'read_project_task', arguments: {} }] };
    }
    const result = JSON.parse((input.messages.at(-1) as any).content);
    expect(result.requirements[0]).toMatchObject(criterion);
    expect(result.remaining).toBe('Inspect sources');
    expect(result.objective).toContain('Inspect this project');
    return { text: 'Inspection still needs to run.', tools: [] };
  } } as unknown as ModelProvider;
  const id = await service(store, provider, projects).send(null, profile, 'Inspect this project', [], undefined, project.id);
  expect(store.chat(id).projectHandoff?.requirements).toHaveLength(1);
});

it('requires model compatibility when inspected project files establish browser inference',async()=>{
  const {store,project,projects,root}=await fixture(3);let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    calls++;
    if(calls===1)return {text:'',tools:[{id:'read',name:'read_project_file',arguments:{path:'note.txt'}}]};
    if(calls===2){const result=JSON.parse((input.messages.at(-1) as any).content);return {text:'',tools:[{id:'contract',name:'update_project_task',arguments:{requirements:[{text:'Inspect the initial note',status:'passed',verification:'inspection',evidenceIds:[result.evidenceId]}],remaining:''}}]};}
    if(calls===4)return {text:'',tools:[{id:'current-contract',name:'update_project_task',arguments:{requirements:[{text:'Implement real browser inference',status:'not_run',verification:'inspection',evidenceIds:[]}],remaining:'Implement browser inference'}}]};
    if(calls===5)return {text:'',tools:[{id:'edit',name:'edit_project_file',arguments:{path:'note.txt',expectedHash:hash('old'),content:'unauthorized model implementation'}}]};
    return {text:'Saved findings.',tools:[]};
  }} as unknown as ModelProvider;
  const chats=service(store,provider,projects);
  const id=await chats.send(null,profile,'Inspect the note',[],undefined,project.id);
  await fs.writeFile(path.join(root,'index.html'),'<script type="module">import * as webllm from "@mlc-ai/web-llm";</script>');
  await chats.send(id,profile,'Now implement GGUF inference in the browser.');
  expect(store.chat(id).projectHandoff?.requiresModelVerification).toBe(true);
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.some(item => item.result.includes('MODEL_CONTRACT_REQUIRED'))).toBe(true);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
});

it('finalizes canceled attempts and invalidates verification when an interrupted edit may have written',async()=>{
  const {store,project,projects,root}=await fixture(3);let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    calls++;
    if(calls===1)return {text:'',tools:[{id:'read',name:'read_project_file',arguments:{path:'note.txt'}}]};
    if(calls===2){const result=JSON.parse((input.messages.at(-1) as any).content);return {text:'',tools:[{id:'contract',name:'update_project_task',arguments:{requirements:[{text:'The note has been checked',status:'passed',verification:'inspection',evidenceIds:[result.evidenceId]}],remaining:''}}]};}
    if(calls===4)return {text:'',tools:[{id:'current-contract',name:'update_project_task',arguments:{requirements:[{text:'Update the note',status:'not_run',verification:'inspection',evidenceIds:[]}],remaining:'Update note'}}]};
    if(calls===5)return {text:'',tools:[{id:'edit',name:'edit_project_file',arguments:{path:'note.txt',expectedHash:hash('old'),content:'written before stop'}}]};
    return {text:'Saved findings.',tools:[]};
  }} as unknown as ModelProvider;
  const chats=service(store,provider,projects);
  const id=await chats.send(null,profile,'Inspect the note',[],undefined,project.id);
  const execute=projects.execute.bind(projects);
  vi.spyOn(projects,'execute').mockImplementation(async(chat,name,args,signal)=>{
    const result=await execute(chat,name,args,signal);
    if(name==='edit_project_file'){chats.stop(chat.id);signal.throwIfAborted();}
    return result;
  });
  await chats.send(id,profile,'Update the note');
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('written before stop');
  expect(store.chat(id).projectHandoff?.requirements[0].status).toBe('not_run');
  expect(store.chat(id).messages.at(-1)?.toolActivity?.find(item => item.name === 'edit_project_file')).toMatchObject({status:'failed',completedAt:expect.any(Number)});
  expect(store.chat(id).messages.at(-1)?.delivery?.status).toBe('stopped');
});

it('accepts a known revision in the legacy hash field without accepting arbitrary tokens',async()=>{
  const {projects,chat,controller,root}=await fixture();const read:any=await projects.execute(chat,'read_project_file',{path:'note.txt'},controller.signal);
  await projects.execute(chat,'patch_project_file',{path:'note.txt',expectedHash:read.revision,oldText:'old',newText:'updated'},controller.signal);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('updated');
  await expect(projects.execute(chat,'patch_project_file',{path:'note.txt',expectedHash:randomUUID(),oldText:'updated',newText:'bad'},controller.signal)).rejects.toThrow('Unknown read revision');
});

it('runs confined level 2 build and file commands without requesting approval', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(2);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node -v' } }));
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'created', timedOut: false, confined: true }));
  const execution = { probe: async () => ({ available: true, version: '1.0.1' }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'command-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  await projects.execute(chat, 'run_project_command', { command: 'mkdir src && echo hello>src/new.txt' }, controller.signal);
  await projects.execute(chat, 'run_project_command', { command: 'npm run build' }, controller.signal);
  await projects.execute(chat, 'edit_project_file', { path: 'nested/new.txt', expectedHash: null, content: 'created' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'nested/new.txt'), 'utf8')).toBe('created');
  expect(execute).toHaveBeenCalledTimes(2);
  expect(approvals.snapshot()).toEqual([]);
});

it.each([true, false])('requires a one-shot decision before Main uses native execution when isolation is unavailable (allow=%s)', async allow => {
  const { directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'smoke passed', confined: false }));
  const execution = { probe: async () => ({ available: false }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'fallback-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const pending = projects.execute(chat, 'run_project_command', { command: 'node --test', purpose: 'test' }, controller.signal);
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(execute).not.toHaveBeenCalled();
  expect(approvals.snapshot()[0].details).toContain('user permissions');
  approvals.answer(approvals.snapshot()[0].id, allow);
  const result = await outcome;
  if (allow) {
    expect(result.error).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 2, approvedNative: true }), controller.signal);
  } else {
    expect(result.error.message).toContain('denied');
    expect(execute).not.toHaveBeenCalled();
  }
});

it.each([true, false])('asks before retrying a sandbox access conflict (allow=%s)', async allow => {
  const { directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn()
    .mockResolvedValueOnce({ exitCode: 1, output: 'PermissionError: [WinError 10013] socket access forbidden by access permissions', timedOut: false, confined: true })
    .mockResolvedValue({ exitCode: 0, output: 'model responded', timedOut: false, confined: false });
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'retry-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const pending = projects.execute(chat, 'run_project_process', { executable: 'node', args: ['-e', 'fetch("http://127.0.0.1:11434")'], purpose: 'test' }, controller.signal);
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(approvals.snapshot()[0]).toMatchObject({ requester: { agent: 'Main', model: 'main', provider: 'ollama', tool: 'run_project_process' } });
  expect(approvals.snapshot()[0].details).toContain('WinError 10013');
  expect(approvals.snapshot()[0].details).toContain('partial effects');
  approvals.answer(approvals.snapshot()[0].id, allow);
  const result = await outcome;
  if (allow) {
    expect(result.error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toMatchObject({ approvedNative: true, confined: false });
  } else {
    expect(result.error.message).toContain('denied');
    expect(execute).toHaveBeenCalledTimes(1);
  }
});

it.each([false, true])('lets Main request sandbox permission before launching a known conflicting command (diagnostic=%s)', async diagnostic => {
  const { directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ok', confined: false }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'explicit-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  if (diagnostic) {
    chat.projectHandoff = newHandoff(undefined, 'Inspect the project');
    chat.projectHandoff.taskPolicy = beginProjectRequest(undefined, 'Do not edit; inspect only', randomUUID());
  }
  const pending = projects.execute(chat, 'run_project_command', { command: 'node -v', sandboxPermissions: 'require_escalated', justification: 'Connect to the local model for a smoke test.' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(execute).not.toHaveBeenCalled();
  expect(approvals.snapshot()[0].details).toContain('Connect to the local model');
  approvals.answer(approvals.snapshot()[0].id, true);
  await pending;
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ approvedNative: true, confined: false }), controller.signal);
});

it.each(['AssertionError: expected 2 to equal 3', 'ModuleNotFoundError: No module named numpy', 'ECONNREFUSED 127.0.0.1:11434'])('does not treat an ordinary program failure as a sandbox conflict: %s', async output => {
  const { directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async () => ({ exitCode: 1, output, timedOut: false, confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'failure-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  expect(await projects.execute(chat, 'run_project_command', { command: 'node -v' }, controller.signal)).toMatchObject({ exitCode: 1, output });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(approvals.snapshot()).toEqual([]);
});

it.each(['source change', 'permissions change', 'stop'])('invalidates a sandbox retry on %s', async change => {
  const { directory, root, store, project, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async () => ({ exitCode: 1, output: 'EACCES: permission denied', timedOut: false, confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'invalidated-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const pending = projects.execute(chat, 'run_project_command', { command: 'node -v' }, controller.signal);
  const rejected = expect(pending).rejects.toThrow(change === 'source change' ? /Source files changed/ : change === 'permissions change' ? /permissions changed/ : /Stopped/);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  if (change === 'stop') controller.abort(new Error('Stopped'));
  else {
    if (change === 'source change') await fs.writeFile(path.join(root, 'note.txt'), 'user edit');
    else store.saveProject({ ...project, policyRevision: 2 });
    approvals.answer(approvals.snapshot()[0].id, true);
  }
  await rejected;
  expect(execute).toHaveBeenCalledTimes(1);
  expect(approvals.snapshot()).toEqual([]);
});

it('offers a retry after a thrown sandbox denial with verbose output', async () => {
  const { directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn().mockRejectedValueOnce(new Error('diagnostic line\n'.repeat(2000) + 'spawn EPERM'))
    .mockResolvedValue({ exitCode: 1, output: 'EACCES again', timedOut: false, confined: false });
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'verbose-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const pending = projects.execute(chat, 'run_project_command', { command: 'node -v' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0].details).toContain('[Earlier output omitted]');
  expect(approvals.snapshot()[0].details).toContain('spawn EPERM');
  approvals.answer(approvals.snapshot()[0].id, true);
  expect(await pending).toMatchObject({ exitCode: 1, output: 'EACCES again' });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(approvals.snapshot()).toEqual([]);
});

it('preserves ordinary Full access execution without asking about an unused sandbox', async () => {
  const { directory, store, chat, controller } = await fixture(3);
  const approvals = new ChatApprovals(() => {}, () => true);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'ok', confined: false }));
  const execution = { probe: async () => ({ available: false }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'full-access-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  expect(await projects.execute(chat, 'run_project_command', { command: 'node -v' }, controller.signal)).toMatchObject({ exitCode: 0 });
  expect(approvals.snapshot()).toEqual([]);
  await projects.execute(chat, 'run_project_command', { command: 'node -v', sandboxPermissions: 'require_escalated', justification: 'Already full access.' }, controller.signal);
  expect(approvals.snapshot()).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(2);
});

it('keeps workers confined and identifies their model when they request command review', async () => {
  const { directory, store, chat, approvals, controller } = await fixture(1);
  const execute = vi.fn(async () => ({ exitCode: 1, output: 'EACCES: access denied', timedOut: false, confined: true }));
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'worker-sandbox-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const child = { ...chat, id: randomUUID(), profile: { ...profile, model: 'worker-model' } };
  await projects.prepareWorker(child, chat, projects.getWorkspace(chat), { ownedPaths: ['note.txt'], readOnly: false });
  const pending = projects.execute(child, 'run_project_command', { command: 'node -v', filesystemAccess: 'workspace-write' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0]).toMatchObject({ chatId: chat.id, requester: { agent: `Worker ${child.id}`, model: 'worker-model', tool: 'run_project_command' } });
  approvals.answer(approvals.snapshot()[0].id, true);
  expect(await pending).toMatchObject({ exitCode: 1, confined: true });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(approvals.snapshot()).toEqual([]);
  await expect(projects.execute(child, 'run_project_command', { command: 'node -v', sandboxPermissions: 'require_escalated' }, controller.signal)).rejects.toMatchObject({ code: 'WORKER_SANDBOX_REQUIRED' });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('uses real native process and localhost access only after approving a sandbox retry', async () => {
  const { directory, store, chat, approvals, controller } = await fixture(2);
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.end('local-model-smoke-ok'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const native = new ProjectExecutionAdapter(path.join(directory, 'unused-runtime'), path.join(directory, 'scratch'));
  const execute = vi.fn(async (request: import('./project-execution').ProjectExecutionRequest, signal: AbortSignal) => {
    if (!request.approvedNative) return { exitCode: 1, output: 'WSAEACCES: network access denied', timedOut: false, confined: true };
    return native.execute(request, signal);
  });
  const execution = { probe: async () => ({ available: true }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'localhost-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const pending = projects.execute(chat, 'run_project_process', { executable: 'node', args: ['-e', `fetch('http://127.0.0.1:${port}').then(r=>r.text()).then(console.log)`], purpose: 'test' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(calls).toBe(0);
  approvals.answer(approvals.snapshot()[0].id, true);
  expect(await pending).toMatchObject({ exitCode: 0, confined: false, output: expect.stringContaining('local-model-smoke-ok') });
  expect(calls).toBe(1);
});

it('runs structured scripts through the real project tool interface', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(3);
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused-runtime'), path.join(directory, 'scratch'));
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'process-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const result: any = await projects.execute(chat, 'run_project_process', { executable: process.execPath, args: ['-'], stdin: 'console.log("real structured script [data-view=]")' }, controller.signal);
  expect(result).toMatchObject({ exitCode: 0, projectChanged: false }); expect(result.output).toContain('[data-view=]');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it('detects command mutations in long single-line source without relying on paginated reads', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(3);
  await fs.writeFile(path.join(root, 'long.js'), '// ' + 'x'.repeat(21000));
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused'), path.join(directory, 'scratch'));
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'long-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const result: any = await projects.execute(chat, 'run_project_process', { executable: process.execPath, args: ['-'], stdin: 'require("fs").appendFileSync("long.js"," changed");process.exit(1)' }, controller.signal);
  expect(result).toMatchObject({ exitCode: 1, projectChanged: true });
});

it('records fresh failure evidence for repeated commands and blocks unverified completion', async () => {
  const { directory, store, projects, project, approvals } = await fixture(3);
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused'), path.join(directory, 'scratch'));
  const tools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'evidence-workspaces')), undefined, { execution });
  let calls = 0; const command = `"${process.execPath}" -e "process.exit(1)"`;
  const provider = { chat: async () => {
    calls++;
    if(calls===1)return {text:'',tools:[{id:'initial',name:'update_project_task',arguments:{requirements:[{text:'Tests pass',status:'not_run',verification:'command',evidenceIds:[]}],remaining:'Run checks'}}]};
    if (calls <= 3) return { text: '', tools: [{ id: `check-${calls}`, name: 'run_project_command', arguments: { command } }] };
    if (calls === 4) return { text: '', tools: [{ id: 'contract', name: 'update_project_task', arguments: { requirements: [{ text: 'Tests pass', status: 'failed', verification: 'command', evidenceIds: [] }], remaining: 'Fix failing command' } }] };
    return { text: 'The command failed; changes are not verified.', tools: [] };
  } } as unknown as ModelProvider;
  const completed = vi.fn();
  const chats = new ChatService(store, provider, () => {}, () => false, undefined, undefined, tools, projectTestRuntime(provider), undefined, completed);
  const id = await chats.send(null, profile, 'Check the project', [], undefined, project.id);
  const saved = store.chat(id), evidence = saved.messages.at(-1)?.sourceEvidence?.filter(item => item.tool === 'run_project_command') ?? [];
  expect(evidence).toHaveLength(2); expect(evidence[0].id).not.toBe(evidence[1].id);
  expect(evidence.every(item => JSON.parse(item.result).exitCode === 1)).toBe(true);
  expect(saved.messages.at(-1)?.toolActivity?.filter(item=>item.name==='run_project_command').every(item => item.status === 'failed')).toBe(true);
  expect(saved.status).toBe('failed'); expect(saved.error).toContain('unresolved blocker'); expect(completed).not.toHaveBeenCalled();
  expect(projects).toBeTruthy();
});

it('preserves stopped task context without replaying actions and invalidates changed sources', async () => {
  const { store, projects, project, root } = await fixture(); let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    if (calls === 1) return { text: '', tools: [{ id: 'read', name: 'read_project_file', arguments: { path: 'note.txt' } }] };
    if (calls === 2) { chats.stop(chats.activeId!); input.signal.throwIfAborted(); }
    expect(JSON.stringify(input.messages)).toContain('Saved task handoff');
    expect(JSON.stringify(input.messages)).toContain('Original coding request');
    return { text: 'The earlier read is preserved; source changed, so prior verification is unknown.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = service(store, provider, projects);
  const id = await chats.send(null, profile, 'Original coding request', [], undefined, project.id);
  expect(store.chat(id).status).toBe('stopped'); expect(store.chat(id).projectHandoff?.reads).toHaveLength(1);
  await fs.writeFile(path.join(root, 'note.txt'), 'user changed source');
  await chats.send(id, profile, 'Resume');
  const resumed = store.chat(id); expect(resumed.status).toBe('idle'); expect(resumed.projectHandoff?.reads).toHaveLength(0);
  expect(resumed.messages.at(-1)?.toolActivity).toBeUndefined();
});

it('drops obsolete edit snapshots so newly verified work stays verified on an unchanged follow-up', async () => {
  const { projects, chat, root, controller } = await fixture();
  chat.projectHandoff = { requirements: [{ text: 'Source is checked', status: 'passed', verification: 'inspection', evidenceIds: [] }], snapshots: [{ path: 'note.txt', hash: hash('old')! }], reads: [], checks: [], changedPaths: ['note.txt'], completedSteps: [], remaining: '', updatedAt: Date.now() };
  await fs.writeFile(path.join(root, 'note.txt'), 'external update');
  await projects.prepare(chat, controller.signal);
  expect(chat.projectHandoff.snapshots).toEqual([]); expect(chat.projectHandoff.requirements[0].status).toBe('not_run');
  chat.projectHandoff.requirements[0].status = 'passed';
  await projects.prepare(chat, controller.signal);
  expect(chat.projectHandoff.requirements[0].status).toBe('passed');
});

it('delivers a disposable project through the real SDK, process and browser, then continues without replay', async () => {
  const { directory, root, store, project, approvals } = await fixture(3);
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused-runtime'), path.join(directory, 'scratch'));
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'delivery-workspaces')), undefined, { execution });
  await fs.writeFile(path.join(root,'index.html'),'<textarea id="question"></textarea><p id="reply"></p><script>question.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();reply.textContent="Observed: "+question.value}}</script>');
  const server=createServer(async (_request,response)=>{response.setHeader('content-type','text/html');response.end(await fs.readFile(path.join(root,'index.html')))});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const policy=new WebPolicy();
  const browser=new ChatBrowser(path.resolve('node_modules'),path.resolve('.build-resources/browser-runtime'),policy,undefined,undefined,()=>true);
  cleanups.push(()=>browser.dispose());
  const capabilities={beginTurn:()=>{},endTurn:async()=>{},handles:(name:string)=>name.startsWith('browser_'),execute:async(id:string,name:string,args:any,signal:AbortSignal)=>{
    policy.allowLocalOrigin(id,url);
    if(name==='browser_open')return browser.open(id,args.url,signal);
    if(name==='browser_fill')return browser.fill(id,args.selector,args.text,args.submit,signal,args.responseSelector);
    return browser.read(id,0,signal,args.selector);
  }} as any;
  let calls = 0;
  const criterion = { text: 'note.txt is updated and the script check passes', verification: 'command', evidenceIds: [] as string[] };
  const interaction={text:'The page receives a question and displays the response',verification:'browser',evidenceIds:[] as string[]};
  let commandEvidence='';
  const provider = { chat: async (input: ChatInput) => {
    const step = ++calls;
    const tool = (name: string, args: unknown) => ({ text: '', tools: [{ id: `delivery-${step}`, name: `mcp__mercury__${name}`, arguments: args }] });
    const last: any = input.messages.filter((item: any) => item.role === 'tool').at(-1);
    const result = last ? JSON.parse(last.content) : undefined;
    if (step === 1) return tool('update_project_task', { requirements: [{ ...criterion, status: 'not_run' },{...interaction,status:'not_run'}], remaining: 'Patch and check' });
    if (step === 2) return tool('read_project_file', { path: 'note.txt' });
    if (step === 3) return tool('patch_project_file', { path: 'note.txt', revision: result.revision, oldText: 'old', newText: 'updated' });
    if (step === 4) return tool('run_project_process', { purpose: 'test', executable: process.execPath, args: ['-'], stdin: 'if(require("fs").readFileSync("note.txt","utf8")!=="updated")process.exit(1);console.log("verified updated source")' });
    if (step === 5) { expect(result.exitCode).toBe(0);commandEvidence=result.evidenceId;return tool('browser_open',{url}); }
    if (step === 6) return tool('browser_fill',{selector:'#question',text:'Test question',submit:true,responseSelector:'#reply'});
    if (step === 7) return tool('browser_read',{selector:'#reply'});
    if (step === 8) { expect(result.selected.text).toBe('Observed: Test question');return tool('update_project_task',{requirements:[{...criterion,status:'passed',evidenceIds:[commandEvidence]},{...interaction,status:'passed',evidenceIds:[result.evidenceId]}],remaining:''}); }
    const text = 'Updated note.txt. The verification script passed.'; input.onText?.(text); return { text, tools: [], usage: { input: Math.ceil(profile.contextLimit * .75), output: 50 } };
  } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(directory, 'agent-sessions'), { executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') });
  cleanups.push(() => runtime.shutdown());
  const chats = new ChatService(store, provider, () => {}, () => false, undefined, capabilities, projects, runtime);
  const id = await chats.send(null, profile, 'Update note.txt, check the resulting file and report the result.', [], undefined, project.id);
  expect(store.chat(id), store.chat(id).error).toMatchObject({ status: 'idle', projectHandoff: { requirements: [{ status: 'passed' },{status:'passed'}] } });
  expect(store.chat(id).messages.at(-1)?.verification).toBe('passed');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('updated');
  const originalSession = store.chat(id).projectRuntime?.sessionId;
  expect(store.chat(id).projectContextTokens).toBeGreaterThanOrEqual(profile.contextLimit * .7);
  await chats.send(id, profile, 'Summarize the saved result; do not redo work.');
  expect(store.chat(id).status, store.chat(id).error).toBe('idle');
  expect(store.chat(id).projectRuntime?.sessionId).not.toBe(originalSession);
  expect(calls).toBe(10);
}, 60000);

it.each(process.env.MERCURY_LIVE_MXC === '1' ? [2, 3] as const : [3] as const)('routes actual level %s Git commands to Mercury history without touching the personal repository', async mode => {
  const { root, directory, store, chat, approvals, controller } = await fixture(mode, true);
  const original = (...args: string[]) => promisify(execFile)('git', ['-C', root, ...args], { windowsHide: true });
  const beforeHead = (await original('rev-parse', 'HEAD')).stdout;
  const beforeIndex = await fs.readFile(path.join(root, '.git', 'index'));
  const beforeConfig = await fs.readFile(path.join(root, '.git', 'config'));
  const execution = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(directory, 'execution'));
  cleanups.push(() => execution.shutdown());
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'command-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'shell checkpoint' }, controller.signal);
  const result = await projects.execute(chat, 'run_project_command', { command: 'git add note.txt && git commit -m Mercury-shell-checkpoint' }, controller.signal);
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, confined: mode === 2 });
  expect((await original('rev-parse', 'HEAD')).stdout).toBe(beforeHead);
  expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(beforeIndex);
  expect(await fs.readFile(path.join(root, '.git', 'config'))).toEqual(beforeConfig);
  const alternate = (...args: string[]) => promisify(execFile)('git', [`--git-dir=${path.join(root, '.mercury', 'git')}`, `--work-tree=${root}`, ...args], { windowsHide: true });
  expect((await alternate('show', 'HEAD:note.txt')).stdout).toBe('shell checkpoint');
  expect((await alternate('log', '-1', '--format=%an|%ae|%cn|%ce')).stdout.trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
  expect((await alternate('remote')).stdout).toBe('');
  expect(approvals.snapshot()).toEqual([]);
});

it('saves responses without dependency graph generation or updates while disabled', async () => {
  const { directory, root, store, chat, approvals, controller } = await fixture(3, true);
  const unavailable = async () => { throw new Error('Dependency graph exceeds the 32 MiB storage limit. Analyze a smaller source project.'); };
  const refresh = vi.fn(unavailable), updateChanged = vi.fn(unavailable);
  const maps = { hasExistingDiagrams: vi.fn(async () => false), refresh, updateChanged } as unknown as ProjectMaps;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'disabled-map-workspaces')), undefined, { maps });
  const context = await projects.prepare(chat, controller.signal);
  expect(context).not.toContain('Mercury updates maps');
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'updated' }, controller.signal);
  expect(await projects.commitResponse(chat, controller.signal)).toMatchObject({ committed: true });
  expect(refresh).not.toHaveBeenCalled();
  expect(updateChanged).not.toHaveBeenCalled();
  const git = (...args: string[]) => promisify(execFile)('git', ['--git-dir=' + path.join(root, '.mercury', 'git'), '--work-tree=' + root, '-C', root, ...args], { windowsHide: true });
  expect((await git('show', 'HEAD:note.txt')).stdout).toBe('updated');
});

it('hides dependency graph tools and rejects stale calls while disabled', async () => {
  const { projects, chat, controller } = await fixture();
  for (const name of ['refresh_project_maps', 'query_project_maps']) {
    expect(projectTools.some(tool => tool.function.name === name)).toBe(false);
    expect(projects.toolsForWorker(false).some(tool => tool.function.name === name)).toBe(false);
    expect(projects.toolsForWorker(true).some(tool => tool.function.name === name)).toBe(false);
    await expect(projects.execute(chat, name, {}, controller.signal)).rejects.toThrow(/temporarily disabled/i);
  }
  await expect(projects.mapStatus(chat, true)).rejects.toThrow(/temporarily disabled/i);
});

it('opens a project without waiting for dependency analysis', async () => {
  const { directory, root, store, approvals } = await fixture();
  const refresh = vi.fn(async () => { throw new Error('Dependency analysis must not block opening a folder.'); });
  const maps = { hasExistingDiagrams: vi.fn(async () => false), refresh } as unknown as ProjectMaps;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'opening-workspaces')), undefined, { maps });
  await projects.initializeProject(root);
  expect(refresh).not.toHaveBeenCalled();
});

it('leaves missing diagrams uninitialized while dependency graphs are disabled', async () => {
  const { directory, store, chat, approvals, controller } = await fixture(3, true);
  let present = false;
  const refresh = vi.fn(async () => { present = true; });
  const maps = { hasExistingDiagrams: vi.fn(async () => present), refresh } as unknown as ProjectMaps;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'initial-workspaces')), undefined, { maps });
  await projects.prepare(chat, controller.signal);
  await projects.prepare(chat, controller.signal);
  expect(refresh).not.toHaveBeenCalled();
});

it('allows outside reads without write authority in read-only mode', async () => {
  const { directory, projects, chat, approvals, controller } = await fixture(1);
  const outside = path.join(directory, 'private.txt'); await fs.writeFile(outside, 'private');
  expect(await projects.execute(chat, 'read_project_file', { path: outside }, controller.signal)).toMatchObject({ hash: hash('private') });
  expect(approvals.snapshot()).toEqual([]);
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

it('creates a Git safety commit after a successful project response', async () => {
  const { store, project, root, projects } = await fixture(3, true);
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (++calls === 1) return {text:'',tools:[{id:'contract',name:'update_project_task',arguments:{requirements:[{text:'The note contains the saved response',status:'not_run',verification:'inspection',evidenceIds:[]}],remaining:'Edit and inspect'}}]};
    if (calls === 2) return { text: '', tools: [{ id: 'edit', name: 'edit_project_file', arguments: { path: 'note.txt', expectedHash: hash('old'), content: 'saved by response' } }] };
    if (calls === 3) return { text: '', tools: [{ id: 'test', name: 'run_project_command', arguments: { purpose: 'test', command: `node -e "require('node:assert').strictEqual(require('node:fs').readFileSync('note.txt','utf8'),'saved by response')"` } }] };
    if (calls === 4) {
      const result = JSON.parse((input.messages.at(-1) as { content: string }).content);
      return { text: '', tools: [{ id: 'verify', name: 'update_project_task', arguments: { requirements: [{ text: 'The note contains the saved response', status: 'passed', verification: 'inspection', evidenceIds: [result.evidenceId] }], remaining: '' } }] };
    }
    return { text: 'Saved safely.', tools: [] };
  } } as unknown as ModelProvider;
  const completed = vi.fn();
  const chats = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, projectTestRuntime(provider), undefined, completed);
  const id = await chats.send(null, profile, 'Update the note', [], undefined, project.id);
  expect(completed).toHaveBeenCalledOnce();
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ id, projectId: project.id, status: 'idle' }));
  const git = (...args: string[]) => promisify(execFile)('git', [`--git-dir=${path.join(root, '.mercury', 'git')}`, `--work-tree=${root}`, '-C', root, ...args], { windowsHide: true });
  expect((await git('log', '-1', '--format=%s')).stdout).toMatch(/^Mercury: save response for /);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('saved by response');
});

it.each([['implementation', false], ['testing', false], ['implementation', true]] as const)('starts a %s subagent before Main explicitly records a checklist (existing=%s)', async (kind, existing) => {
  const { projects, store, project, root, chat } = await fixture(3);
  if (existing) {
    chat.projectHandoff = newHandoff(undefined, 'Create worker.txt');
    chat.projectHandoff.requirements = [{ id: 'original', text: 'Preserve the original task criterion', status: 'not_run', verification: 'inspection', evidenceIds: [] }];
    store.saveChat(chat);
  }
  let mainCalls = 0;
  let workerCalls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (String((input.messages[0] as any).content).includes('coding worker')) {
      if (++workerCalls === 1) return { text: '', tools: [{ id: 'write', name: 'edit_project_file', arguments: { path: 'worker.txt', expectedHash: null, content: 'delegated content' } }] };
      expect(JSON.parse((input.messages.at(-1) as any).content)).not.toHaveProperty('error');
      return { text: 'Created worker.txt. Checks not run.', tools: [] };
    }
    if (++mainCalls === 1) return { text: '', tools: [{ id: 'spawn', name: 'start_project_task', arguments: { kind, task: 'Create worker.txt with delegated content', context: '', ownedPaths: ['worker.txt'], checks: ['Inspect worker.txt content'] } }] };
    if (mainCalls === 2) {
      const result = JSON.parse((input.messages.at(-1) as any).content);
      expect(result).not.toHaveProperty('error');
      return { text: '', tools: [{ id: 'wait', name: 'wait_project_tasks', arguments: { ids: [result.id] } }] };
    }
    return { text: 'Delegated work saved; checks remain.', tools: [] };
  } } as unknown as ModelProvider;
  const id = await service(store, provider, projects).send(existing ? chat.id : null, profile, 'Create worker.txt using a subagent', [], undefined, project.id);
  const saved = store.chat(id);
  expect(saved.projectAssignments, JSON.stringify(saved.messages.at(-1)?.toolActivity)).toHaveLength(1);
  expect(saved.projectAssignments![0].status).toBe('completed');
  expect(workerCalls).toBe(2);
  expect(await fs.readFile(path.join(root, 'worker.txt'), 'utf8')).toBe('delegated content');
  expect(saved.projectHandoff!.requirements.map(item => item.text)).toEqual([...(existing ? ['Preserve the original task criterion'] : []), 'Create worker.txt with delegated content', 'Inspect worker.txt content']);
  expect(saved.projectHandoff!.requirements.every(item => item.status === 'not_run' && !item.evidenceIds.length)).toBe(true);
  expect(saved.projectHandoff!.requirements.every(item => item.verification === 'inspection')).toBe(true);
  expect(JSON.stringify(saved.messages.flatMap(item => item.toolActivity ?? []))).not.toContain('NEED_TASK_CONTRACT');
});

it.each([[], ['../outside']] as string[][])('does not create criteria for an invalid worker scope %j', async ownedPaths => {
  const { projects, store, project } = await fixture();
  let calls = 0;
  const provider = { chat: async () => ++calls === 1
    ? { text: '', tools: [{ id: 'spawn', name: 'start_project_task', arguments: { kind: 'implementation', task: 'Create worker.txt', context: '', ownedPaths } }] }
    : { text: 'The assignment scope must be corrected.', tools: [] }
  } as unknown as ModelProvider;
  const id = await service(store, provider, projects).send(null, profile, 'Create worker.txt using a subagent', [], undefined, project.id);
  const saved = store.chat(id);
  expect(saved.projectHandoff!.requirements).toEqual([]);
  expect(saved.projectAssignments ?? []).toEqual([]);
  expect(saved.messages.at(-1)!.toolActivity![0].status).toBe('failed');
});

it('starts project conversations directly with Main, offers project reads to Subagent, and persists ownership', async () => {
  const { projects, store, project } = await fixture();
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    const names = (input.tools as any[]).map(tool => tool.function.name);
    if (calls === 1) {
      expect(input.messages.map(item => String((item as { content: string }).content)).join('\n')).toContain('PROJECT CODING CONTEXT');
      expect(names).toContain('edit_project_file');
      return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Inspect note.txt', context: 'Read only note.txt.' } }] };
    }
    if (calls === 2) {
      expect(names).toContain('read_project_file'); expect(names).not.toContain('edit_project_file');
      return { text: 'The file is available for inspection.', tools: [] };
    }
    return { text: 'Ready to work on the project.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = service(store, provider, projects);
  const id = await chats.send(null, profile, 'Inspect the project', [], undefined, project.id);
  expect(store.chat(id)).toMatchObject({ projectId: project.id, status: 'idle', workspacePath: project.path });
  expect(calls).toBe(3);
  await expect(chats.send(id, profile, 'Move ownership', [], undefined, randomUUID())).rejects.toThrow(/different project/);
});

it('offers attachment reads but creates no generated chat files in project mode', async () => {
  const { directory, projects, store, project } = await fixture();
  const files = new ChatFiles(path.join(directory, 'attachments'), async () => Buffer.from(''), async () => '');
  const create = vi.spyOn(files, 'create');
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    const names = (input.tools as any[]).map(tool => tool.function.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('create_file');
    expect(names).not.toContain('create_pdf');
    if (++calls === 1) return { text: '', tools: [{ id: 'invented', name: 'create_file', arguments: { name: 'stockpile.txt', content: 'wrong destination' } }] };
    return { text: 'Use the project folder.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = new ChatService(store, provider, () => {}, () => false, files, undefined, projects, projectTestRuntime(provider));
  const id = await chats.send(null, profile, 'Create a file in the project', [], undefined, project.id);
  expect(create).not.toHaveBeenCalled();
  expect(store.chat(id).messages.flatMap(message => message.files ?? [])).toEqual([]);
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
  const pending = service(store, provider, projects).send(null, profile, 'Review independent areas', [], undefined, project.id);
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
  const chats = service(store, provider, projects);
  const pending = chats.send(null, profile, 'Start work', [], undefined, project.id);
  await expect.poll(() => entered).toBe(true);
  store.saveProject({ ...project, permissionMode: 1, policyRevision: 2 }); chats.projectPolicyChanged(project.id);
  const id = await pending;
  expect(store.chat(id).status).toBe('stopped'); expect(store.chat(id).error).toContain('permissions changed');
});
