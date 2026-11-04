import { it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store';
import { LocalProviders } from './providers';
import { ChatService } from './chat';
import { ChatApprovals } from './chat-approvals';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { ProjectExecutionAdapter } from './project-execution';
import { ProjectServers } from './project-servers';
import { ClaudeProjectRuntime } from './project-agent-runtime';
import { ProjectWorkers } from './project-workers';
import { WebPolicy } from './web-policy';
import { WebSearch } from './web-search';
import { ChatBrowser } from './chat-browser';
import { ChatPlugins } from './chat-plugins';
import { ChatCapabilities } from './chat-capabilities';

it.skipIf(process.env.MERCURY_TASK_LIVE !== '1')('records a real Mercury project task using the saved local model', async () => {
  const root = path.resolve(process.env.MERCURY_TASK_ROOT ?? 'test-results/mercury-task-live');
  await fs.mkdir(root, { recursive: true });
  const db = new DatabaseSync(path.join(process.env.APPDATA!, 'Local Plan Agent/state.sqlite'), { readOnly: true });
  const savedProjects = db.prepare('SELECT data FROM projects').all().map((r: any) => JSON.parse(r.data));
  const original = savedProjects.find((p: any) => /miku-room/i.test(p.name));
  const savedChats = db.prepare('SELECT data FROM chats ORDER BY updated_at DESC').all().map((r: any) => JSON.parse(r.data));
  const selected = savedChats.find((c: any) => c.projectId === original.id);
  const savedSettings = JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'app'").get() as any).data);
  db.close();
  const profile = selected.profile;
  if (!['ollama', 'lmstudio'].includes(profile.provider)) throw new Error('This live diagnostic requires a saved local model.');
  const connection = savedSettings.connections.find((c: any) => c.id === profile.connectionId);
  if (connection.hasToken || connection.apiToken) throw new Error('Configure credential handling explicitly for an authenticated endpoint.');
  const store = new Store(path.join(root, 'state.sqlite'));
  store.saveSettings({ connections: [connection], mainModel: profile, subagentModel: profile, plannerModel: null, projectWorkerConcurrency: 2 });
  const project = { ...original, id: store.projects().find(p => p.path === original.path)?.id ?? randomUUID(), permissionMode: 3 as const };
  store.saveProject(project);
  let chain = Promise.resolve();
  const log = (event: unknown) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event as object }) + '\n';
    chain = chain.then(() => fs.appendFile(path.join(root, 'actions.jsonl'), line));
  };
  const providers = new LocalProviders(() => store.settings());
  const approvals = new ChatApprovals(() => {}, id => Boolean(store.chat(id).projectId));
  const policy = new WebPolicy();
  const channel = process.env.MERCURY_TASK_BROWSER_CHANNEL;
  if (channel && !['chromium', 'chrome', 'msedge'].includes(channel)) throw new Error('Unsupported diagnostic browser channel.');
  const browser = new ChatBrowser(path.resolve('node_modules'), path.resolve('.build-resources/browser-runtime'), policy, approvals, undefined, () => true, channel as 'chromium' | 'chrome' | 'msedge' | undefined);
  const plugins = new ChatPlugins(path.join(root, 'plugins'), process.cwd(), policy, approvals);
  const capabilities = new ChatCapabilities(browser, plugins, new WebSearch(policy));
  const execution = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(root, 'execution'), { runtimeReadRoots: [path.dirname(process.execPath)] });
  const servers = new ProjectServers(execution, policy);
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(root, 'workspaces')), undefined, { execution, servers });
  const runtime = new ClaudeProjectRuntime(providers, path.join(root, 'agent-sessions'), { executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') });
  const run = runtime.run.bind(runtime);
  runtime.run = input => run({ ...input, execute: async (name, args, attempt) => {
    const callId = randomUUID();
    const metadata = { callId, agent: input.agentId ?? 'main', name, attemptId: attempt?.id };
    log({ type: 'tool-start', ...metadata, args });
    // Diagnostic-only steering: deliver a human observer's findings before the
    // next action, explicitly reporting that the requested action did not run.
    // Archive exact feedback for the prompt/action review; never edit target files.
    const feedbackPath = path.join(root, 'observer-feedback.txt');
    const archivedFeedback = path.join(root, `observer-feedback-${callId}.txt`);
    const feedback = await fs.rename(feedbackPath, archivedFeedback).then(() => fs.readFile(archivedFeedback, 'utf8')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (feedback !== undefined) {
      const result = { code: 'OBSERVER_STEERING', error: 'The observer supplied updated findings. This requested action was NOT executed. Read the feedback and choose the next action.', observerFeedback: feedback };
      log({ type: 'observer-feedback', ...metadata, feedback });
      log({ type: 'tool-end', ...metadata, result });
      return result;
    }
    try { const result = await input.execute(name, args, attempt); log({ type: 'tool-end', ...metadata, result }); return result; }
    catch (error) { log({ type: 'tool-error', ...metadata, error: String(error) }); throw error; }
  }, onToolValidationFailure: async (name, args, attempt) => {
    log({ type: 'validation-failure', name, args, error: String(attempt.validationError) });
    return input.onToolValidationFailure!(name, args, attempt);
  } });
  const previousMessages = new Map<string, Record<string, any>>();
  let pendingSnapshot: any;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotWrite: Promise<void> | undefined;
  let snapshotError: unknown;
  const flushSnapshot = async () => {
    if (snapshotWrite) return snapshotWrite;
    snapshotWrite = (async () => {
      while (pendingSnapshot) {
        const chat = pendingSnapshot; pendingSnapshot = undefined;
        const snapshot = JSON.stringify(chat, null, 2);
        const temporary = path.join(root, 'latest-chat.json.tmp');
        await fs.writeFile(temporary, snapshot);
        await fs.rename(temporary, path.join(root, 'latest-chat.json'));
      }
    })();
    try { await snapshotWrite; } finally { snapshotWrite = undefined; }
  };
  const notify = (chat: any) => {
    // Keep one latest pending snapshot, never queue full multi-MB chat copies.
    pendingSnapshot = chat;
    if (!snapshotTimer && !snapshotWrite) snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      void flushSnapshot().catch(error => { snapshotError = error; });
    }, 1000);
    const changes = (chat.messages ?? []).flatMap((message: any) => {
      const { id, role, content, model, notice, metrics, verification, delivery, runtimeBuild, recoveryPolicy } = message;
      const captured = JSON.parse(JSON.stringify({ id, role, content, model, notice, metrics, verification, delivery, runtimeBuild, recoveryPolicy }));
      const previous = previousMessages.get(message.id);
      const changed: Record<string, unknown> = { id: message.id };
      for (const [key, value] of Object.entries(captured)) {
        if (JSON.stringify(previous?.[key]) === JSON.stringify(value)) continue;
        if (typeof value === 'string' && typeof previous?.[key] === 'string' && value.startsWith(previous[key]))
          changed[key + 'Append'] = value.slice(previous[key].length);
        else changed[key] = value;
      }
      previousMessages.set(message.id, captured);
      return Object.keys(changed).length > 1 ? [changed] : [];
    });
    log({ type: 'chat-update', id: chat.id, status: chat.status, error: chat.error, messages: changes });
  };
  const workers = new ProjectWorkers(store, providers, runtime, projects, new ProjectWorktreeService(path.join(root, 'workers')), notify);
  const chats = new ChatService(store, providers, notify, () => false, undefined, capabilities, projects, runtime, workers);
  const prompt = process.env.MERCURY_TASK_PROMPT_FILE
    ? await fs.readFile(path.resolve(process.env.MERCURY_TASK_PROMPT_FILE), 'utf8')
    : process.env.MERCURY_TASK_CHAT_ID
    ? 'Continue the original static Qwen2.5 browser conversion using your saved findings and task handoff. Resolve the recorded blocker using the tool feedback. Do not restart research or reword existing requirements. Finish implementation and verify actual browser inference. Do not push or publish.'
    : await fs.readFile(path.join(root, 'prompt.txt'), 'utf8');
  const runtimeSource = createHash('sha256');
  for (const file of ['project-agent-runtime.ts', 'project-progress.ts', 'project-tools.ts', 'project-tool-input.ts', 'chat.ts', 'chat-browser.ts', 'chat-capabilities.ts', 'workspace.ts', 'project-servers.ts']) {
    runtimeSource.update(file); runtimeSource.update(await fs.readFile(path.join('src/main', file)));
  }
  log({ type: 'run-start', project: project.path, profile, runtimeSourceFingerprint: runtimeSource.digest('hex'), browserChannel: channel ?? 'bundled-shell', prompt });
  const heartbeat = setInterval(() => {
    const memory = process.memoryUsage();
    const metrics = { active: chats.activeIds, heapMB: Math.round(memory.heapUsed / 1048576), rssMB: Math.round(memory.rss / 1048576), snapshotWriting: Boolean(snapshotWrite), snapshotPending: Boolean(pendingSnapshot) };
    log({ type: 'diagnostic-metrics', ...metrics }); console.log('Live Mercury task:', JSON.stringify(metrics));
  }, 30000);
  const control = setInterval(() => { void fs.stat(path.join(root,'stop')).then(() => { for(const id of chats.activeIds) chats.stop(id); },()=>{}); },1000);
  try {
    const id = await chats.send(process.env.MERCURY_TASK_CHAT_ID ?? null, profile, prompt, [], undefined, project.id);
    const chat = store.chat(id);
    log({ type: 'run-end', id, status: chat.status, error: chat.error });
    clearTimeout(snapshotTimer); snapshotTimer = undefined;
    await flushSnapshot(); await chain;
    if (snapshotError) throw snapshotError;
    console.log(JSON.stringify({ id, status: chat.status, error: chat.error }));
    expect(chat.status, chat.error).toBe('idle');
  } finally {
    clearInterval(heartbeat);
    clearInterval(control);
    clearTimeout(snapshotTimer);
    await runtime.shutdown(); await capabilities.dispose(); await servers.shutdown(); await execution.shutdown(); await flushSnapshot(); await chain; store.close();
  }
}, 3600000);
