import type { ChatMessage } from '../shared/types';

export function workSeconds(message: ChatMessage, active: boolean, now: number): number | null {
  const end = active ? now : message.completedAt;
  if (typeof message.startedAt !== 'number' || !Number.isFinite(message.startedAt) || typeof end !== 'number' || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - message.startedAt) / 1000));
}
