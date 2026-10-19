import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatThread, ModelProfile } from '../shared/types';
import type { ModelProvider } from './providers';
import { Store } from './store';

export class ChatService {
  private active: { id: string; controller: AbortController } | null = null;
  get activeId(): string | null { return this.active?.id ?? null; }
  constructor(private store: Store, private providers: ModelProvider, private notify: () => void, private agentRunning: () => boolean) {}
  private save(chat: ChatThread): void { this.store.saveChat(chat); this.notify(); }
  stop(id: string): void {
    if (this.active?.id !== id) throw new Error('This chat is not generating a response.');
    this.active.controller.abort(new Error('Response stopped.'));
  }
  async send(id: string | null, selected: ModelProfile, message: string): Promise<string> {
    if (this.active || this.agentRunning()) throw new Error('Wait for the current response or stop it first.');
    const connection = this.store.settings().connections.find(item => item.id === selected.connectionId && item.provider === selected.provider);
    if (!connection) throw new Error('Save this model connection in Model settings first.');
    const profile = { ...selected, endpoint: connection.url };
    const chat: ChatThread = id ? this.store.chat(id) : { id: randomUUID(), title: message.slice(0, 70), profile, messages: [], status: 'idle', updatedAt: Date.now() };
    const history = chat.messages.filter(item => item.content.trim()).map(({ role, content }) => ({ role, content }));
    const messages = [{ role: 'system', content: 'You are Mercury, a helpful assistant. Answer the user directly. Use Markdown formatting when helpful: headings, bold, italics, lists, quotes, tables, and fenced code blocks with a language label. For underline use <u>text</u>.' }, ...history, { role: 'user', content: message }];
    if (JSON.stringify(messages).length > Math.min(profile.contextLimit * 3, 300_000)) throw new Error('This chat exceeds the selected model’s context limit. Start a new chat or choose a larger context in settings.');
    const controller = new AbortController();
    this.active = { id: chat.id, controller };
    chat.profile = profile;
    chat.status = 'streaming';
    delete chat.error;
    chat.messages.push({ id: randomUUID(), role: 'user', content: message });
    const response: ChatMessage = { id: randomUUID(), role: 'assistant', content: '', model: profile.model, startedAt: Date.now() };
    chat.messages.push(response);
    this.save(chat);
    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; this.save(chat); }, 75);
    };
    try {
      const result = await this.providers.chat({ profile, messages, signal: controller.signal, onText: delta => {
        if (controller.signal.aborted) return;
        if (delta.trim() && !response.thinkingEndedAt) response.thinkingEndedAt = Date.now();
        response.content = (response.content + delta).slice(0, 200_001);
        if (response.content.length > 200_000) { controller.abort(new Error('Response length limit reached.')); return; }
        publish();
      }, onReasoning: delta => {
        if (controller.signal.aborted) return;
        response.reasoning = ((response.reasoning ?? '') + delta).slice(0, 100_001);
        if (response.reasoning.length > 100_000) { controller.abort(new Error('Thinking output limit reached. Partial reasoning has been saved.')); return; }
        publish();
      } });
      if (controller.signal.aborted) throw controller.signal.reason;
      response.content = result.text;
      if (result.reasoning) response.reasoning = result.reasoning.slice(0, 100_000);
      if (!response.content.trim()) throw new Error('The model returned no answer. Try another model or send the message again.');
      chat.status = 'idle';
    } catch (error) {
      chat.status = controller.signal.aborted ? 'stopped' : 'failed';
      chat.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (publishTimer) clearTimeout(publishTimer);
      response.completedAt = Date.now(); this.active = null; this.save(chat);
    }
    return chat.id;
  }
}
