import { afterEach, expect, it, vi } from 'vitest';
import { Notification } from 'electron';
import { showResponseNotification } from './response-notifications';
import type { ChatThread } from '../shared/types';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { Notification: Object.assign(vi.fn(function () { return Object.assign(new EventEmitter(), { show: vi.fn() }); }), { isSupported: vi.fn(() => true) }) };
});
afterEach(() => { vi.clearAllMocks(); vi.mocked(Notification.isSupported).mockReturnValue(true); });
const chat: ChatThread = { id: 'chat', title: 'Miku room', profile: { provider: 'ollama', model: 'test', contextLimit: 8192 }, messages: [], status: 'idle', updatedAt: 1 };

it('shows a native completion notification and brings Mercury forward when clicked', () => {
  const focus = vi.fn();
  showResponseNotification(chat, focus);
  expect(Notification).toHaveBeenCalledWith({ title: 'Mercury finished responding', body: 'Miku room' });
  const notification = vi.mocked(Notification).mock.results[0].value as Notification;
  expect(notification.show).toHaveBeenCalledOnce();
  expect(focus).not.toHaveBeenCalled();
  notification.emit('click');
  expect(focus).toHaveBeenCalledOnce();
});
it('does not attempt a notification when the operating system does not support it', () => {
  vi.mocked(Notification.isSupported).mockReturnValue(false);
  showResponseNotification(chat, vi.fn());
  expect(Notification).not.toHaveBeenCalled();
});
