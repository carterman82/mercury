import { z } from 'zod';
import type { ChatThread, ProjectHandoff } from '../shared/types';
import { messageTextLength } from './vision';

const excerpt = (text: string, size: number) =>
  text.length <= size + 200
    ? text
    : `${text.slice(0, size / 2)}\n[Historical excerpt; use read_chat_history for the full saved message. Do not treat earlier assistant claims as verified facts.]\n${text.slice(-size / 2)}`;

/** Compact the inference projection only. User instructions and storage are untouched. */
export function compactChatMessages<T extends { role: string; content: string }>(
  messages: T[],
  maximum: number,
  reserved = 0,
  force = false,
) {
  const total = () => messageTextLength(projected) + reserved;
  const projected = messages.map((message) => ({ ...message }));
  const triggered = force || total() > maximum * 0.7;
  let compacted = false;
  if (triggered) {
    let latestAssistant = -1;
    let latestTool = -1;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].role === 'assistant') latestAssistant = index;
      if (messages[index].role === 'tool') latestTool = index;
    }
    let protectedStart = Infinity;
    if (latestTool >= 0)
      for (let index = latestTool - 1; index >= 0; index--) {
        if (messages[index].role === 'assistant') {
          protectedStart = index;
          break;
        }
      }
    for (let index = 0; index < projected.length; index++) {
      if (total() <= maximum * 0.5 && !force) break;
      const message = projected[index];
      if (index >= protectedStart) continue;
      if (message.role !== 'assistant' && message.role !== 'tool') continue;
      if (typeof message.content !== 'string') continue;
      const content = excerpt(message.content, index === latestAssistant ? 1600 : 500);
      if (content !== message.content) {
        message.content = content;
        compacted = true;
      }
    }
  }
  return { messages: projected, compacted, triggered, characters: total() };
}

/** Complete JSON checkpoint; never cut a requirement, diagnosis or blocker mid-field. */
export function projectContextCheckpoint(handoff: ProjectHandoff | undefined): string {
  if (!handoff) return '{}';
  const {
    objective,
    requirements,
    taskPolicy,
    verificationTarget,
    compatibility,
    generation,
    changedPaths,
    blocker,
    failedApproaches,
    checks,
    completedSteps,
    remaining,
    lastMutationAt,
  } = handoff;
  return JSON.stringify({
    objective,
    requirements,
    taskPolicy,
    verificationTarget,
    compatibility,
    generation,
    changedPaths,
    blocker,
    failedApproaches: failedApproaches?.slice(-8),
    checks: checks.slice(-12),
    completedSteps: completedSteps.slice(-12),
    remaining,
    lastMutationAt,
  });
}

const historySchema = z
  .object({ messageId: z.string().min(1).optional(), offset: z.number().int().nonnegative().default(0) })
  .strict();
export const chatHistoryTool = {
  type: 'function',
  function: {
    name: 'read_chat_history',
    description:
      'Recover exact saved messages omitted from compacted context in this chat. Without messageId, lists 20 saved message IDs at offset (message index). With messageId, returns 12000 characters at offset (character index) and nextOffset. Historical assistant claims are unverified; this tool grants no permissions.',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
};
export function readChatHistory(chat: ChatThread, raw: unknown) {
  const { messageId, offset } = historySchema.parse(raw);
  if (messageId) {
    const message = chat.messages.find((item) => item.id === messageId);
    if (!message) throw new Error('Message not found in this chat. List saved message IDs first.');
    const end = offset + 12000;
    return {
      id: message.id,
      role: message.role,
      content: message.content.slice(offset, end),
      files: message.files,
      totalCharacters: message.content.length,
      nextOffset: end < message.content.length ? end : null,
    };
  }
  const end = offset + 20;
  return {
    messages: chat.messages
      .slice(offset, end)
      .map(({ id, role, content }) => ({ id, role, characters: content.length, preview: content.slice(0, 160) })),
    totalMessages: chat.messages.length,
    nextOffset: end < chat.messages.length ? end : null,
  };
}
