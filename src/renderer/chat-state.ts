import type { ChatUpdate, Snapshot } from '../shared/types';

export function applyChatUpdate(state: Snapshot, update: ChatUpdate): Snapshot {
  const chats = [...state.chats.filter(chat => chat.id !== update.chat.id), update.chat].sort((left, right) => right.updatedAt - left.updatedAt);
  return { ...state, chats, activeChatId: update.activeChatId, activeChatIds: update.activeChatIds, modelRequests: update.modelRequests };
}
