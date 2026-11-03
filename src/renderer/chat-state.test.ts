import { expect, it } from 'vitest';
import { applyChatUpdate } from './chat-state';
import type { Snapshot } from '../shared/types';

const profile = { provider: 'ollama' as const, connectionId: 'local', model: 'test', contextLimit: 8192 };
const state: Snapshot = { projects: [], sessions: [], settings: { connections: [], mainModel: null, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null, chats: [
  { id: 'old', title: 'Old', profile, messages: [], status: 'idle', updatedAt: 1 },
  { id: 'active', title: 'Active', profile, messages: [], status: 'streaming', updatedAt: 2 },
] };

it('replaces one chat without rebuilding unrelated state', () => {
  const updated = applyChatUpdate(state, { chat: { ...state.chats[1], status: 'idle', updatedAt: 3 }, activeChatId: null, activeChatIds: [], modelRequests: [] });
  expect(updated.chats).toEqual([{ ...state.chats[1], status: 'idle', updatedAt: 3 }, state.chats[0]]);
  expect(updated.settings).toBe(state.settings);
});
