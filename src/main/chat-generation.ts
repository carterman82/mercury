import type { ChatInput, ChatResult, ModelProvider } from './providers';
import { ThinkingGuard, ThinkingLimitError, type ThinkingFailure } from './thinking-guard';
import { InactivityWatchdog } from './inactivity';

const recoveryInstruction = '\nYour previous generation stalled in repetitive thinking. Answer the latest user message directly now. Do not revisit the same alternatives. For a brief acknowledgment such as "lit", "cool", or "thanks", give a brief acknowledgment. If essential information is missing, ask one concise question. Do not create another file unless the latest request needs one. Continue to use file tools when needed. Never repeat a completed tool action.';

/** Retry only interrupted generation, before any returned tool calls are executed. */
export async function generateChatTurn(provider: ModelProvider, input: ChatInput, onRecovery: (reason: ThinkingFailure) => void, limits = { thinkingMs: 120_000, maxCharacters: Infinity }): Promise<ChatResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal.throwIfAborted();
    const controller = new AbortController();
    const idle = new InactivityWatchdog(limits.thinkingMs, new ThinkingLimitError('timeout'));
    const signal = AbortSignal.any([input.signal, controller.signal, idle.signal]);
    const guard = new ThinkingGuard(limits.maxCharacters);
    let answering = false;
    let emittedText = false;
    const progress = () => { answering = true; idle.progress(); };
    let detach = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      detach = () => signal.removeEventListener('abort', abort);
    });
    const messages = attempt ? input.messages.map((message: any) => message.role === 'system' ? { ...message, content: message.content + recoveryInstruction } : message) : input.messages;
    try {
      const result = await Promise.race([provider.chat({
        ...input, messages, signal, disableThinking: attempt > 0,
        onRequestState: state => {
          if (state === 'queued') idle.pause(); else idle.progress();
          input.onRequestState?.(state);
        },
        onText: delta => { if (!signal.aborted) { if (delta.trim()) { emittedText = true; progress(); } input.onText?.(delta); } },
        onToolProgress: () => { if (!signal.aborted) { progress(); input.onToolProgress?.(); } },
        onReasoning: delta => {
          if (signal.aborted) return;
          try {
            input.onReasoning?.(delta);
            if (!answering) guard.push(delta);
            if (delta.trim()) idle.progress();
          } catch (error) { controller.abort(error); }
        },
      }), interrupted]);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      input.signal.throwIfAborted(); // A user Stop must never trigger recovery.
      if (!(error instanceof ThinkingLimitError)) throw error;
      if (error.kind === 'timeout' && emittedText) throw new Error('The model made no progress for two minutes. The partial answer is saved; send a follow-up to continue.');
      if (attempt) throw new Error(error.kind === 'timeout' ? 'The model made no progress for two minutes, including after a retry. Partial output is saved.' : 'The model kept getting stuck while thinking. Partial output is saved. Try another model or send a more specific message.');
      onRecovery(error.kind);
    } finally { idle.dispose(); detach(); }
  }
  throw new Error('Unable to finish the response.');
}
