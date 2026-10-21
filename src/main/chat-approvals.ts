import { randomUUID } from 'node:crypto';
import type { ChatApproval } from '../shared/types';

export class ChatApprovals {
  private pending = new Map<string, { approval: ChatApproval; answer: (allow: boolean) => void }>();
  private denied = new Set<string>();
  constructor(private changed: () => void, private unrestrictedChat: (chatId: string) => boolean = () => false) {}
  snapshot(): ChatApproval[] { return [...this.pending.values()].map(item => item.approval); }
  beginTurn(chatId: string): void { this.denied.delete(chatId); }
  cancelProject(projectId: string): void {
    for (const request of [...this.pending.values()]) if ((request.approval as ProjectApproval).projectId === projectId) request.answer(false);
  }
  cancelChat(chatId: string): void {
    for (const request of [...this.pending.values()]) if (request.approval.chatId === chatId) request.answer(false);
  }
  answer(id: string, allow: boolean): void {
    const request = this.pending.get(id); if (!request) throw new Error('This approval is no longer waiting.'); request.answer(allow);
  }
  request(chatId: string, title: string, details: string, signal: AbortSignal, metadata: ProjectApprovalMetadata = {}): Promise<void> {
    signal.throwIfAborted();
    if (this.unrestrictedChat(chatId)) return Promise.resolve();
    if (details.length > 12000) return Promise.reject(new Error('Approval details exceed the review limit. Reduce the arguments; no permission was granted and nothing was executed.'));
    if (this.denied.has(chatId)) return Promise.reject(new Error('The user already denied an action in this turn. Wait for a new user message; do not ask again.'));
    return new Promise((resolve, reject) => {
      const approval = { ...metadata, id: randomUUID(), chatId, title: title.slice(0, 200), details, at: Date.now() };
      const done = (allow: boolean, error?: unknown) => {
        if (!this.pending.delete(approval.id)) return;
        if (!allow) this.denied.add(chatId);
        clearTimeout(timer); signal.removeEventListener('abort', cancel); this.changed();
        if (allow) resolve(); else reject(error ?? new Error('The user denied this action. Do not retry it or find another way to perform it.'));
      };
      const cancel = () => done(false, signal.reason);
      const timer = setTimeout(() => done(false, new Error('Approval timed out. Ask the user before trying again.')), 5 * 60_000);
      this.pending.set(approval.id, { approval, answer: allow => done(allow) });
      signal.addEventListener('abort', cancel, { once: true }); this.changed();
    });
  }
}

export interface ProjectApprovalMetadata {
  projectId?: string;
  policyRevision?: number;
  kind?: 'read' | 'write' | 'command' | 'plugin' | 'integrate';
  agentId?: string;
  paths?: string[];
}
type ProjectApproval = ChatApproval & ProjectApprovalMetadata;
