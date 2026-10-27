import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, DiscoveryResult, Snapshot } from '../shared/types';
import { MAX_CHAT_ATTACHMENTS } from '../shared/chat-files';

const call = <T>(name: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`api:${name}`, ...args);
const api: DesktopApi = {
  snapshot: () => call('snapshot'),
  onUpdate: (callback: (snapshot: Snapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },
  openProject: () => call('openProject'),
  updateProjectPermissions: (projectId, mode) => call('updateProjectPermissions', projectId, mode),
  projectMapStatus: id => call('projectMapStatus', id),
  refreshProjectMaps: id => call('refreshProjectMaps', id),
  readProjectDiagram: (id, path) => call('readProjectDiagram', id, path),
  createSession: (projectId, objective) => call('createSession', projectId, objective),
  updateSettings: settings => call('updateSettings', settings),
  connectChatGPT: id => call('connectChatGPT', id),
  cancelChatGPTSignIn: () => call('cancelChatGPTSignIn'),
  connectCodex: () => call('connectCodex'),
  cancelCodexSignIn: () => call('cancelCodexSignIn'),
  cachedDiscovery: () => call('cachedDiscovery'),
  onDiscovery: (callback: (result: DiscoveryResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: DiscoveryResult) => callback(result);
    ipcRenderer.on('discovery:update', listener);
    return () => ipcRenderer.removeListener('discovery:update', listener);
  },
  disconnectConnection: id => call('disconnectConnection', id),
  discover: connection => call('discover', connection),
  autoDiscover: force => call('autoDiscover', force),
  probe: profile => call('probe', profile),
  addChatFiles: async files => {
    if (!files.length || files.length > MAX_CHAT_ATTACHMENTS) throw new Error(`Drop between one and ${MAX_CHAT_ATTACHMENTS} files.`);
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (paths.some(filename => !filename)) throw new Error('Drop files from your computer. Browser-generated files are not supported.');
    return call('addChatFiles', paths);
  },
  saveChatFile: id => call('saveChatFile', id),
  previewChatFile: (id, page) => call('previewChatFile', id, page),
  previewChatBrowser: id => call('previewChatBrowser', id),
  sendChat: (id, profile, message, attachments, submittedAt, projectId) => call('sendChat', id, profile, message, attachments, submittedAt, projectId),
  stopChat: id => call('stopChat', id),
  answerChatApproval: (id, allow) => call('answerChatApproval', id, allow),
  openLink: url => call('openLink', url),
  plan: (id, feedback) => call('plan', id, feedback),
  savePlan: (id, content) => call('savePlan', id, content),
  approvePlan: (id, revision) => call('approvePlan', id, revision),
  exportPlan: id => call('exportPlan', id),
  answerCommand: (id, requestId, allow, remember) => call('answerCommand', id, requestId, allow, remember),
  stop: id => call('stop', id),
  resume: id => call('resume', id),
};
contextBridge.exposeInMainWorld('desktop', api);
