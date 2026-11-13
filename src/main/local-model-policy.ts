import type { ModelProfile } from '../shared/types';
import { estimateContextTokens } from './model-context';
import { LOCAL_GENERATION_LIMITS } from './thinking-guard';

/** Exact checkpoint family, including publisher prefixes and quantized variants. */
export function localModelPolicy(profile: ModelProfile, requested?: number, context?: unknown) {
  const coderNext = /(?:^|\/)qwen3-coder-next(?:$|[:@]|[._-](?:q\d|iq\d|\d+bit|mlx|gguf|ud|fp|bf))/i.test(
    profile.model,
  );
  const available = Math.max(1, profile.contextLimit - (context ? estimateContextTokens(context) : 0) - 256);
  const maxOutputTokens = Math.max(1, Math.min(LOCAL_GENERATION_LIMITS.outputTokens, requested ?? Infinity, available));
  return {
    nonThinking: coderNext,
    sampling: coderNext ? { temperature: 1, top_p: 0.95, top_k: 40 } : {},
    maxOutputTokens,
  };
}
