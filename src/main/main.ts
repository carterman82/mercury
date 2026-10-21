import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { planMarkdown } from '../shared/plan';
import type { DesktopApi, ModelConnection, ModelProfile, Session, Settings, Snapshot } from '../shared/types';
import { endpoint, LocalProviders } from './providers';
import { autoDiscover } from './discovery';
import { DiscoveryCache, discoveryKey } from './discovery-cache';
import { Runner } from './runner';
import { Store } from './store';
import { ChatService } from './chat';
import { ChatGPTAuth } from './chatgpt-auth';
import { CodexService } from './codex';
import { cloudEndpoint } from './cloud-providers';
import { ChatFiles } from './chat-files';
import { readChatPdf, renderChatPdf, previewChatPdf } from './chat-pdf';
import { FileFormats } from './file-formats';
import { ChatApprovals } from './chat-approvals';
import { ChatBrowser } from './chat-browser';
import { ChatPlugins } from './chat-plugins';
import { ChatCapabilities } from './chat-capabilities';
import { WebPolicy } from './web-policy';
import { WebSearch } from './web-search';
import { MAX_CHAT_ATTACHMENTS } from '../shared/chat-files';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const providerSchema = z.enum(['ollama', 'lmstudio', 'openai', 'claude', 'codex']);
const connectionSchema = z.object({ id: z.string().min(1).max(100), provider: providerSchema, label: z.string().min(1).max(120), url: z.string().url(), apiToken: z.string().max(4096).optional(), hasToken: z.boolean().optional(), auth: z.literal('chatgpt').optional(), deviceId: z.string().max(200).optional(), deviceLabel: z.string().max(200).optional(), maxConcurrentRequests: z.number().int().min(1).max(32).optional() });
const profileSchema = z.object({ provider: providerSchema, connectionId: z.string().optional(), endpoint: z.string().url().optional(), model: z.string().min(1), contextLimit: z.number().int().min(2048).max(Number.MAX_SAFE_INTEGER), contextMode: z.enum(['auto', 'manual']).optional(), toolVerified: z.boolean().optional() });
const localPoolProfileSchema = profileSchema.refine(profile => profile.provider === 'lmstudio' || profile.provider === 'ollama', 'Additional pool models must use a local model server.');
const settingsSchema = z.object({
  connections: z.array(connectionSchema).max(50),
  mainModel: profileSchema.nullable(),
  plannerModel: profileSchema.nullable(),
  subagentModel: profileSchema.nullable(),
  additionalMainModels: z.array(localPoolProfileSchema).max(31).optional(),
  additionalSubagentModels: z.array(localPoolProfileSchema).max(31).optional(),
});

let window: BrowserWindow | null = null;
let store: Store;
let providers: LocalProviders;
let runner: Runner;
let chats: ChatService;
let discovery: DiscoveryCache;
let approvals: ChatApprovals;

function snapshot(): Snapshot {
  return { projects: store.projects(), sessions: store.sessions(), chats: store.chats(), settings: store.settings(), activeRole: runner.activeRole, activeChatId: chats.activeId, activeChatIds: chats.activeIds, modelRequests: providers.requestCounts, chatApprovals: approvals?.snapshot() ?? [] };
}
function noChat(): void { if (chats.activeId) throw new Error('Stop the chat response before starting an agent run.'); }
function notify(): void { if (window && !window.isDestroyed()) window.webContents.send('state:update', snapshot()); }
function authenticated(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized application request.');
}
function handle<T extends keyof DesktopApi>(name: T, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(`api:${name}`, (event, ...args) => { authenticated(event); return handler(event, ...args); });
}

app.whenReady().then(async () => {
  app.setName('Mercury');
  // Keep existing projects, sessions and protected tokens through the rename.
  app.setPath('userData', path.join(app.getPath('appData'), 'Local Plan Agent'));
  if (process.env.LOCAL_PLAN_AGENT_USER_DATA) {
    const directory = path.resolve(process.env.LOCAL_PLAN_AGENT_USER_DATA);
    await fs.mkdir(directory, { recursive: true });
    app.setPath('userData', directory);
  }
  store = new Store(path.join(app.getPath('userData'), 'state.sqlite'));
  const readSecret = (id: string) => {
    const encrypted = store.secret(id);
    if (!encrypted) return undefined;
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  };
  const writeSecret = (id: string, value: string | null) => {
    if (value && !safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
    store.saveSecret(id, value ? safeStorage.encryptString(value).toString('base64') : null);
  };
  const chatGPT = new ChatGPTAuth(readSecret, writeSecret, url => shell.openExternal(url));
  const codex = new CodexService(path.join(app.getPath('userData'), 'codex'), url => shell.openExternal(url));
  providers = new LocalProviders(() => store.settings(), readSecret, () => discovery.invalidate(), id => chatGPT.token(id), notify, codex);
  const pdfRuntime = app.isPackaged ? path.join(process.resourcesPath, 'pdf-runtime', 'node_modules', 'pdfjs-dist') : path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist');
  const formats = new FileFormats(app.isPackaged ? path.join(process.resourcesPath, 'file-runtime') : app.getAppPath(), app.isPackaged ? path.join(process.resourcesPath, 'pdf-runtime') : app.getAppPath());
  const chatFiles = new ChatFiles(path.join(app.getPath('userData'), 'chat-files'), renderChatPdf, bytes => readChatPdf(bytes, pdfRuntime, image => formats.ocr(image)), formats);
  approvals = new ChatApprovals(notify, chatId => {
    const chat = store.chat(chatId);
    return Boolean(chat.projectId && store.project(chat.projectId).permissionMode === 3);
  });
  // Network fixtures are only possible with an explicitly isolated test data profile.
  const fixtureOrigin = process.env.LOCAL_PLAN_AGENT_USER_DATA ? process.env.MERCURY_TEST_NETWORK_ORIGIN : undefined;
  const policy = new WebPolicy(fixtureOrigin);
  const web = new WebSearch(policy, process.env.LOCAL_PLAN_AGENT_USER_DATA ? process.env.MERCURY_TEST_WEB_SEARCH : undefined);
  runner = new Runner(store, providers, notify, web);
  const browser = new ChatBrowser(app.isPackaged ? path.join(process.resourcesPath, 'browser-tools', 'node_modules') : path.join(app.getAppPath(), 'node_modules'), app.isPackaged ? path.join(process.resourcesPath, 'browser-runtime') : path.join(app.getAppPath(), '.build-resources', 'browser-runtime'), policy, approvals);
  const plugins = new ChatPlugins(path.join(app.getPath('userData'), 'plugins'), app.isPackaged ? path.join(process.resourcesPath, 'file-runtime') : app.getAppPath(), policy, approvals, process.env.LOCAL_PLAN_AGENT_USER_DATA ? process.env.MERCURY_TEST_PLUGIN_REGISTRY : undefined);
  const capabilities = new ChatCapabilities(browser, plugins, web);
  const projectTools = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(app.getPath('userData'), 'project-workspaces')));
  chats = new ChatService(store, providers, notify, () => runner.running, chatFiles, capabilities, projectTools);
  let quitting = false;
  app.on('before-quit', event => { if (quitting) return; event.preventDefault(); quitting = true; codex.dispose(); void capabilities.dispose().finally(() => app.quit()); });
  discovery = new DiscoveryCache(settings => autoDiscover(settings, providers), store.discoveryCache(), value => store.saveDiscoveryCache(value));

  window = new BrowserWindow({
    width: 1480, height: 930, minWidth: 950, minHeight: 620,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    title: 'Mercury', backgroundColor: '#101010',
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  handle('snapshot', () => snapshot());
  const checkModels = async () => {
    const settings = store.settings();
    const key = discoveryKey(settings);
    const result = await discovery.get(settings, true);
    if (key === discoveryKey(store.settings()) && window && !window.isDestroyed()) {
      providers.rememberModels(result.models, result.connections);
      window.webContents.send('discovery:update', result);
    }
    return result;
  };
  handle('cachedDiscovery', () => {
    const cached = discovery.peek(store.settings());
    if (cached) providers.rememberModels(cached.models, cached.connections);
    void checkModels().catch(() => {
      if (window && !window.isDestroyed()) window.webContents.send('discovery:update', { ...(cached ?? { connections: [], models: [], applications: [] }), diagnostics: ['Model check failed. Refresh models to try again.'] });
    });
    return cached;
  });
  handle('cancelCodexSignIn', () => codex.cancelSignIn());
  handle('connectCodex', async () => {
    if (runner.running || chats.activeId) throw new Error('Stop the active response before connecting Codex.');
    const connection = await codex.signIn();
    const settings = store.settings();
    settings.connections = [...settings.connections.filter(item => item.id !== connection.id), connection];
    store.saveSettings(settings); discovery.invalidate(); notify();
  });
  handle('cancelChatGPTSignIn', () => chatGPT.cancelSignIn());
  handle('connectChatGPT', async (_event, input?: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
    const id = z.string().max(100).optional().parse(input);
    if (id && !store.settings().connections.some(item => item.id === id && item.auth === 'chatgpt')) throw new Error('ChatGPT account not found.');
    const account = await chatGPT.signIn(id);
    const settings = store.settings();
    const connection: ModelConnection = { ...account, provider: 'openai', url: 'https://api.openai.com', auth: 'chatgpt', hasToken: true };
    settings.connections = [...settings.connections.filter(item => item.id !== account.id), connection];
    store.saveSettings(settings);
    discovery.invalidate(); notify();
  });
  handle('disconnectConnection', async (_event, raw: string) => {
    const id = z.string().min(1).max(100).parse(raw);
    if (runner.running || chats.activeId) throw new Error('Stop the active response before disconnecting an account.');
    const settings = store.settings();
    if (settings.connections.find(item => item.id === id)?.provider === 'codex') await codex.disconnect();
    settings.connections = settings.connections.filter(item => item.id !== id);
    for (const key of ['mainModel', 'plannerModel', 'subagentModel'] as const) if (settings[key]?.connectionId === id) settings[key] = null;
    settings.additionalMainModels = settings.additionalMainModels?.filter(profile => profile.connectionId !== id);
    settings.additionalSubagentModels = settings.additionalSubagentModels?.filter(profile => profile.connectionId !== id);
    writeSecret(id, null); writeSecret(`${id}-registration`, null);
    store.saveSettings(settings); discovery.invalidate(); notify();
  });
  handle('openProject', async () => {
    const chosen = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const canonical = await fs.realpath(chosen.filePaths[0]);
    const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    let project = store.projects().find(item => identity(item.path) === identity(canonical));
    if (!project) {
      project = { id: randomUUID(), path: canonical, name: path.basename(canonical), permissionMode: 2, policyRevision: 1 };
      store.saveProject(project);
    }
    notify();
    return project;
  });
  handle('updateProjectPermissions', (_event, rawId: string, rawMode: number) => {
    const project = store.project(z.string().uuid().parse(rawId));
    const mode = z.union([z.literal(1), z.literal(2), z.literal(3)]).parse(rawMode);
    if (project.permissionMode === mode) return;
    store.saveProject({ ...project, permissionMode: mode, policyRevision: (project.policyRevision ?? 1) + 1 });
    chats.projectPolicyChanged(project.id);
    for (const chat of store.chats()) if (chat.projectId === project.id) approvals.cancelChat(chat.id);
    notify();
  });
  handle('createSession', (_event, projectId: string, objective: string) => {
    if (!store.projects().some(project => project.id === projectId)) throw new Error('Project not found.');
    const text = z.string().trim().min(1).max(10_000).parse(objective);
    const now = Date.now();
    const session: Session = { id: randomUUID(), projectId, objective: text, status: 'draft', createdAt: now, updatedAt: now, events: [], plan: null, changes: [], command: null, assignments: null };
    store.saveSession(session);
    notify();
    return session;
  });
  handle('updateSettings', (_event, incoming: Settings) => {
    const previousKey = discoveryKey(store.settings());
    const settings = settingsSchema.parse(incoming);
    if (new Set(settings.connections.map(item => item.id)).size !== settings.connections.length) throw new Error('Connections must have unique IDs.');
    for (const connection of settings.connections) {
      endpoint(connection.url);
      if (connection.provider === 'codex' && (connection.id !== 'codex-account' || connection.url !== 'https://chatgpt.com' || connection.apiToken !== undefined || connection.auth || !store.settings().connections.some(item => item.id === connection.id && item.provider === 'codex'))) throw new Error('Use Connect with Codex to connect this account.');
      if (connection.provider === 'openai' || connection.provider === 'claude') cloudEndpoint(connection);
      const previous = store.settings().connections.find(item => item.id === connection.id);
      if (previous && store.secret(connection.id) && (previous.provider !== connection.provider || previous.url !== connection.url) && connection.apiToken === undefined) throw new Error('Enter new credentials when changing a connection address or provider.');
      if (connection.auth === 'chatgpt' && (previous?.auth !== 'chatgpt' || connection.apiToken !== undefined)) throw new Error('Use Continue with ChatGPT to connect this account.');
      if (previous?.auth === 'chatgpt' && connection.auth !== 'chatgpt') throw new Error('Disconnect the ChatGPT account before changing authentication.');
    }
    for (const profile of [settings.mainModel, settings.plannerModel, settings.subagentModel, ...(settings.additionalMainModels ?? []), ...(settings.additionalSubagentModels ?? [])]) {
      if (!profile) continue;
      const connection = settings.connections.find(item => item.id === profile.connectionId);
      if (!connection || connection.provider !== profile.provider) throw new Error(`The model ${profile.model} needs a matching saved connection.`);
    }
    for (const connection of settings.connections) {
      if (connection.apiToken !== undefined) {
        if (connection.apiToken && !safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this computer.');
        store.saveSecret(connection.id, connection.apiToken ? safeStorage.encryptString(connection.apiToken).toString('base64') : null);
      }
    }
    store.saveSettings({ ...settings, connections: settings.connections.map(({ apiToken, ...connection }) => connection) });
    if (previousKey !== discoveryKey(store.settings()) || settings.connections.some(item => item.apiToken !== undefined)) discovery.invalidate();
    notify();
  });
  handle('discover', (_event, input: ModelConnection) => {
    const connection = connectionSchema.parse(input);
    endpoint(connection.url);
    if (connection.provider === 'codex' && !store.settings().connections.some(item => item.id === connection.id && item.provider === 'codex')) throw new Error('Connect with Codex first.');
    const previous = store.settings().connections.find(item => item.id === connection.id);
    if (previous && connection.apiToken === undefined && (previous.provider !== connection.provider || previous.url !== connection.url || previous.auth !== connection.auth)) throw new Error('Saved credentials can only be used with their original connection.');
    if (connection.auth === 'chatgpt' && !store.settings().connections.some(item => item.id === connection.id && item.auth === 'chatgpt')) throw new Error('Connect ChatGPT first.');
    return providers.discover(connection);
  });
  handle('autoDiscover', async (_event, force?: boolean) => {
    const result = await discovery.get(store.settings(), z.boolean().optional().parse(force) ?? false);
    providers.rememberModels(result.models, result.connections);
    if (window && !window.isDestroyed()) window.webContents.send('discovery:update', result);
    return result;
  });
  handle('probe', async (_event, profile: ModelProfile) => { noChat(); if (runner.running) throw new Error('Wait for the current agent run.'); return providers.probe(profileSchema.parse(profile)); });
  handle('addChatFiles', async (_event, raw: string[]) => {
    const paths = z.array(z.string().min(1).max(32768)).min(1).max(MAX_CHAT_ATTACHMENTS).parse(raw);
    return Promise.all(paths.map(filename => chatFiles.import(filename)));
  });
  handle('saveChatFile', async (_event, raw: string) => {
    const id = z.string().uuid().parse(raw);
    const file = await chatFiles.get(id);
    const chosen = await dialog.showSaveDialog(window!, { defaultPath: path.join(app.getPath('downloads'), file.name) });
    if (chosen.canceled || !chosen.filePath) return null;
    await fs.writeFile(chosen.filePath, await chatFiles.bytes(id));
    return chosen.filePath;
  });
  handle('previewChatBrowser', (_event, raw: string) => browser.preview(z.string().uuid().parse(raw)));
  handle('previewChatFile', async (_event, raw: string, rawPage?: number) => {
    const id = z.string().uuid().parse(raw);
    const page = z.number().int().min(1).max(100000).optional().parse(rawPage) ?? 1;
    const file = await chatFiles.get(id);
    const bytes = await chatFiles.bytes(id);
    if (bytes.subarray(0, 5).toString() === '%PDF-') {
      try { return await previewChatPdf(bytes, pdfRuntime, page); }
      catch { return { kind: 'text', text: await chatFiles.text(id), note: 'PDF page preview unavailable. Showing extracted text instead.' }; }
    }
    const image = await chatFiles.image(id).catch(() => null);
    if (image) return { kind: 'image', image: `data:${image.mimeType};base64,${image.data}` };
    return { kind: 'text', text: await chatFiles.text(id), note: file.note };
  });
  handle('sendChat', (_event, id: string | null, profile: ModelProfile, message: string, rawIds?: string[], rawSubmittedAt?: number, rawProjectId?: string) => {
    const ids = z.array(z.string().uuid()).max(MAX_CHAT_ATTACHMENTS).optional().parse(rawIds) ?? [];
    const text = z.string().trim().max(30_000).parse(message);
    if (!text && !ids.length) throw new Error('Add a message or attach a file.');
    const before = new Set(chats.activeIds);
    const completion = chats.send(z.string().uuid().nullable().parse(id), profileSchema.parse(profile), text || 'Please read the attached files.', ids, z.number().finite().nonnegative().optional().parse(rawSubmittedAt), z.string().uuid().optional().parse(rawProjectId));
    const started = chats.activeIds.find(chatId => !before.has(chatId));
    if (!started) return completion; // Validation failures still reach the caller.
    // Acknowledge creation immediately; streaming state and errors arrive through snapshots.
    void completion.catch(() => notify());
    return started;
  });
  handle('stopChat', (_event, id: string) => chats.stop(z.string().uuid().parse(id)));
  handle('answerChatApproval', (_event, id: string, allow: boolean) => approvals.answer(z.string().uuid().parse(id), z.boolean().parse(allow)));
  handle('openLink', (_event, raw: string) => {
    const url = new URL(z.string().url().max(8000).parse(raw));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links can be opened.');
    return shell.openExternal(url.toString());
  });
  handle('plan', (_event, sessionId: string, feedback?: string) => { noChat(); return runner.plan(z.string().uuid().parse(sessionId), String(feedback ?? '').slice(0, 10_000)); });
  handle('savePlan', (_event, sessionId: string, content: unknown) => runner.savePlan(z.string().uuid().parse(sessionId), content as any));
  handle('approvePlan', (_event, sessionId: string, revision: number) => { noChat(); return runner.approve(z.string().uuid().parse(sessionId), z.number().int().parse(revision)); });
  handle('answerCommand', (_event, sessionId: string, requestId: string, allow: boolean, remember: boolean) => runner.answerCommand(z.string().uuid().parse(sessionId), z.string().uuid().parse(requestId), z.boolean().parse(allow), z.boolean().parse(remember)));
  handle('stop', (_event, sessionId: string) => runner.stop(z.string().uuid().parse(sessionId)));
  handle('resume', (_event, sessionId: string) => { noChat(); return runner.resume(z.string().uuid().parse(sessionId)); });
  handle('exportPlan', async (_event, sessionId: string) => {
    const session = store.session(z.string().uuid().parse(sessionId));
    if (!session.plan) throw new Error('There is no plan to export.');
    const project = store.projects().find(item => item.id === session.projectId);
    const chosen = await dialog.showSaveDialog(window!, { defaultPath: path.join(project?.path ?? app.getPath('documents'), 'PLAN.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (chosen.canceled || !chosen.filePath) return null;
    const exists = await fs.stat(chosen.filePath).then(() => true).catch(() => false);
    if (exists) {
      const answer = await dialog.showMessageBox(window!, { type: 'warning', buttons: ['Cancel', 'Overwrite'], defaultId: 0, cancelId: 0, message: `Overwrite ${chosen.filePath}?` });
      if (answer.response !== 1) return null;
    }
    await fs.writeFile(chosen.filePath, planMarkdown(session.plan.content), 'utf8');
    return chosen.filePath;
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
});

app.on('window-all-closed', () => app.quit());
