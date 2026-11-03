import type { ChatMessage } from '../shared/types';

export function formatWorkDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remainder}s` : minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function workSeconds(message: ChatMessage, active: boolean, now: number): number | null {
  const end = active ? now : message.completedAt;
  if (typeof message.startedAt !== 'number' || !Number.isFinite(message.startedAt) || typeof end !== 'number' || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - message.startedAt) / 1000));
}
