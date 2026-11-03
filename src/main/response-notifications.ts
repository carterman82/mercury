import { Notification } from 'electron';
import type { ChatThread } from '../shared/types';

const active = new Set<Notification>();

export function showResponseNotification(chat: ChatThread, focus: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Mercury finished responding',
    body: chat.title.slice(0, 160) || 'Your response is ready.',
  });
  active.add(notification);
  const release = () => active.delete(notification);
  notification.once('close', release);
  notification.once('failed', release);
  notification.once('click', () => { release(); focus(); });
  try { notification.show(); } catch (error) { release(); throw error; }
}
