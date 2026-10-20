import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, Snapshot } from '../shared/types';

const call = <T>(name: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`api:${name}`, ...args);
const api: DesktopApi = {
  snapshot: () => call('snapshot'),
  onUpdate: (callback: (snapshot: Snapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },
  openProject: () => call('openProject'),
  createSession: (projectId, objective) => call('createSession', projectId, objective),
  updateSettings: settings => call('updateSettings', settings),
  connectChatGPT: id => call('connectChatGPT', id),
  cancelChatGPTSignIn: () => call('cancelChatGPTSignIn'),
  disconnectConnection: id => call('disconnectConnection', id),
  discover: connection => call('discover', connection),
  autoDiscover: force => call('autoDiscover', force),
  probe: profile => call('probe', profile),
  addChatFiles: async files => {
    if (!files.length || files.length > 8) throw new Error('Drop between one and eight files.');
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (paths.some(filename => !filename)) throw new Error('Drop files from your computer. Browser-generated files are not supported.');
    return call('addChatFiles', paths);
  },
  saveChatFile: id => call('saveChatFile', id),
  previewChatFile: (id, page) => call('previewChatFile', id, page),
  previewChatBrowser: id => call('previewChatBrowser', id),
  sendChat: (id, profile, message, attachments) => call('sendChat', id, profile, message, attachments),
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
