import type { ChatInput, ChatResult, ModelProvider } from './providers';
import { ThinkingGuard, ThinkingLimitError, type ThinkingFailure } from './thinking-guard';
import { InactivityWatchdog } from './inactivity';
import { FINAL_GENERATION_INSTRUCTION, RunBudget, RunLimitError } from './run-budget';

const recoveryInstruction = '\nYour previous generation stalled in repetitive thinking. Answer the latest user message directly now. Do not revisit the same alternatives. For a brief acknowledgment such as "lit", "cool", or "thanks", give a brief acknowledgment. If essential information is missing, ask one concise question. Do not create another file unless the latest request needs one. Continue to use file tools when needed. Never repeat a completed tool action.';

/** Retry only interrupted generation, before any returned tool calls are executed. */
export async function generateChatTurn(provider: ModelProvider, input: ChatInput, onRecovery: (reason: ThinkingFailure) => void, limits = { thinkingMs: 120_000, maxCharacters: 30_000 }): Promise<ChatResult> {
  const budget = input.runBudget ?? new RunBudget();
  const guarded = provider.generationGuarded && ['ollama', 'lmstudio'].includes(input.profile.provider);
  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal.throwIfAborted();
    const summaryOnly = budget.generation();
    const controller = new AbortController();
    const idle = new InactivityWatchdog(limits.thinkingMs, new ThinkingLimitError('timeout'));
    const signal = AbortSignal.any([input.signal, controller.signal, idle.signal]);
    const guard = new ThinkingGuard(['ollama', 'lmstudio'].includes(input.profile.provider) ? limits.maxCharacters : Infinity);
    let emittedText = false;
    const progress = () => { if (!guarded) idle.progress(); };
    let detach = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      detach = () => signal.removeEventListener('abort', abort);
    });
    const messages = [...input.messages, ...(attempt ? [{ role: 'system', content: recoveryInstruction }] : []), ...(summaryOnly ? [{ role: 'system', content: FINAL_GENERATION_INSTRUCTION }] : [])];
    try {
      // Real local providers own detection, timers and resource cleanup. This
      // fallback also protects alternate ModelProvider implementations.
      if (guarded) idle.pause();
      const result = await Promise.race([provider.chat({
        ...input, messages, signal, disableThinking: attempt > 0 || input.disableThinking,
        ...(summaryOnly ? { tools: [], toolChoice: { type: 'none' as const } } : {}),
        onRequestState: state => {
          if (state === 'queued' || guarded) idle.pause(); else idle.progress();
          input.onRequestState?.(state);
        },
        onText: delta => { if (!signal.aborted) { if (delta.trim()) { emittedText = true; progress(); } input.onText?.(delta); } },
        onToolProgress: () => { if (!signal.aborted) { progress(); input.onToolProgress?.(); } },
        onReasoning: delta => {
          if (signal.aborted) return;
          try {
            input.onReasoning?.(delta);
            if (!guarded) guard.push(delta);
            if (!guarded && delta.trim()) idle.progress();
          } catch (error) { controller.abort(error); }
        },
      }), interrupted]);
      signal.throwIfAborted();
      if (summaryOnly && result.tools.length) throw new RunLimitError('The final summary attempted tool actions. Partial work is saved.');
      return result;
    } catch (error) {
      input.signal.throwIfAborted(); // A user Stop must never trigger recovery.
      if (!(error instanceof ThinkingLimitError)) throw error;
      if (error.kind === 'timeout' && emittedText) throw new Error('The model made no progress for two minutes. The partial answer is saved; send a follow-up to continue.');
      if (attempt) throw new ThinkingLimitError(error.kind, error.kind === 'timeout' ? 'The model made no progress for two minutes, including after a retry. Partial output is saved.' : `The model kept getting stuck while thinking (${error.kind}) after one recovery attempt. Partial output is saved; send a follow-up to continue.`);
      budget.claimRecovery();
      onRecovery(error.kind);
    } finally { idle.dispose(); detach(); }
  }
  throw new Error('Unable to finish the response.');
}
