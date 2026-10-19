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
import { cloudEndpoint } from './cloud-providers';
import { ChatFiles } from './chat-files';
import { readChatPdf, renderChatPdf } from './chat-pdf';
import { FileFormats } from './file-formats';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const providerSchema = z.enum(['ollama', 'lmstudio', 'openai', 'claude']);
const connectionSchema = z.object({ id: z.string().min(1).max(100), provider: providerSchema, label: z.string().min(1).max(120), url: z.string().url(), apiToken: z.string().max(4096).optional(), hasToken: z.boolean().optional(), auth: z.literal('chatgpt').optional() });
const profileSchema = z.object({ provider: providerSchema, connectionId: z.string().optional(), endpoint: z.string().url().optional(), model: z.string().min(1), contextLimit: z.number().int().min(2048).max(1_000_000), toolVerified: z.boolean().optional() });
const settingsSchema = z.object({
  connections: z.array(connectionSchema).max(50),
  defaultModel: profileSchema.nullable(),
  overrides: z.object({ planner: profileSchema.optional(), critic: profileSchema.optional(), synthesizer: profileSchema.optional(), coder: profileSchema.optional() }),
});

let window: BrowserWindow | null = null;
let store: Store;
let providers: LocalProviders;
let runner: Runner;
let chats: ChatService;
let discovery: DiscoveryCache;

function snapshot(): Snapshot {
  return { projects: store.projects(), sessions: store.sessions(), chats: store.chats(), settings: store.settings(), activeRole: runner.activeRole, activeChatId: chats.activeId };
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
  providers = new LocalProviders(() => store.settings(), readSecret, () => discovery.invalidate(), id => chatGPT.token(id));
  runner = new Runner(store, providers, notify);
  const pdfRuntime = app.isPackaged ? path.join(process.resourcesPath, 'pdf-runtime', 'node_modules', 'pdfjs-dist') : path.join(app.getAppPath(), 'node_modules', 'pdfjs-dist');
  const formats = new FileFormats(app.isPackaged ? path.join(process.resourcesPath, 'file-runtime') : app.getAppPath(), app.isPackaged ? path.join(process.resourcesPath, 'pdf-runtime') : app.getAppPath());
  const chatFiles = new ChatFiles(path.join(app.getPath('userData'), 'chat-files'), renderChatPdf, bytes => readChatPdf(bytes, pdfRuntime, image => formats.ocr(image)), formats);
  chats = new ChatService(store, providers, notify, () => runner.running, chatFiles);
  discovery = new DiscoveryCache(settings => autoDiscover(settings, providers), store.discoveryCache(), value => store.saveDiscoveryCache(value));

  window = new BrowserWindow({
    width: 1480, height: 930, minWidth: 950, minHeight: 620,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    title: 'Mercury', backgroundColor: '#101010',
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  handle('snapshot', () => snapshot());
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
  handle('disconnectConnection', (_event, raw: string) => {
    const id = z.string().min(1).max(100).parse(raw);
    if (runner.running || chats.activeId) throw new Error('Stop the active response before disconnecting an account.');
    const settings = store.settings();
    settings.connections = settings.connections.filter(item => item.id !== id);
    if (settings.defaultModel?.connectionId === id) settings.defaultModel = null;
    settings.overrides = Object.fromEntries(Object.entries(settings.overrides).filter(([, profile]) => profile.connectionId !== id));
    writeSecret(id, null); writeSecret(`${id}-registration`, null);
    store.saveSettings(settings); discovery.invalidate(); notify();
  });
  handle('openProject', async () => {
    const chosen = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const canonical = await fs.realpath(chosen.filePaths[0]);
    let project = store.projects().find(item => item.path.toLowerCase() === canonical.toLowerCase());
    if (!project) {
      project = { id: randomUUID(), path: canonical, name: path.basename(canonical) };
      store.saveProject(project);
    }
    notify();
    return project;
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
      if (connection.provider === 'openai' || connection.provider === 'claude') cloudEndpoint(connection);
      const previous = store.settings().connections.find(item => item.id === connection.id);
      if (previous && store.secret(connection.id) && (previous.provider !== connection.provider || previous.url !== connection.url) && connection.apiToken === undefined) throw new Error('Enter new credentials when changing a connection address or provider.');
      if (connection.auth === 'chatgpt' && (previous?.auth !== 'chatgpt' || connection.apiToken !== undefined)) throw new Error('Use Continue with ChatGPT to connect this account.');
      if (previous?.auth === 'chatgpt' && connection.auth !== 'chatgpt') throw new Error('Disconnect the ChatGPT account before changing authentication.');
    }
    for (const profile of [settings.defaultModel, ...Object.values(settings.overrides)]) {
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
    const previous = store.settings().connections.find(item => item.id === connection.id);
    if (previous && connection.apiToken === undefined && (previous.provider !== connection.provider || previous.url !== connection.url || previous.auth !== connection.auth)) throw new Error('Saved credentials can only be used with their original connection.');
    if (connection.auth === 'chatgpt' && !store.settings().connections.some(item => item.id === connection.id && item.auth === 'chatgpt')) throw new Error('Connect ChatGPT first.');
    return providers.discover(connection);
  });
  handle('autoDiscover', (_event, force?: boolean) => discovery.get(store.settings(), z.boolean().optional().parse(force) ?? false));
  handle('probe', async (_event, profile: ModelProfile) => { noChat(); if (runner.running) throw new Error('Wait for the current agent run.'); return providers.probe(profileSchema.parse(profile)); });
  handle('addChatFiles', async (_event, raw: string[]) => {
    const paths = z.array(z.string().min(1).max(32768)).min(1).max(8).parse(raw);
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
  handle('sendChat', (_event, id: string | null, profile: ModelProfile, message: string, rawIds?: string[]) => {
    const ids = z.array(z.string().uuid()).max(8).optional().parse(rawIds) ?? [];
    const text = z.string().trim().max(30_000).parse(message);
    if (!text && !ids.length) throw new Error('Add a message or attach a file.');
    return chats.send(z.string().uuid().nullable().parse(id), profileSchema.parse(profile), text || 'Please read the attached files.', ids);
  });
  handle('stopChat', (_event, id: string) => chats.stop(z.string().uuid().parse(id)));
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
