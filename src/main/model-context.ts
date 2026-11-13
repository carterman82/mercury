import type { ModelProfile } from '../shared/types';
import type { ModelProvider } from './providers';

/** Loaded capacity is a runtime constraint, independent of a model's advertised maximum. */
export async function loadedModelProfile(provider: ModelProvider, profile: ModelProfile, signal: AbortSignal): Promise<ModelProfile> {
  const loaded = await provider.loadedContextLimit?.(profile, signal);
  signal.throwIfAborted();
  return typeof loaded === 'number' && Number.isSafeInteger(loaded) && loaded > 0
    ? { ...profile, contextLimit: Math.min(profile.contextLimit, loaded) }
    : { ...profile };
}

/** Conservative text estimate; tool schemas and a response reserve count too.
 * Binary payloads have provider-specific costs and are not mistaken for text. */
export function estimateContextTokens(request: unknown): number {
  return Math.ceil(JSON.stringify(request, (key, value) =>
    ['images', 'documents'].includes(key) ? '[media payload]' :
      value?.type === 'base64' && typeof value.data === 'string' ? { ...value, data: '[media payload]' } : value,
  ).length / 3);
}

export function assertContextCapacity(profile: ModelProfile, request: unknown, outputTokens = Math.min(1024, Math.floor(profile.contextLimit / 4))): void {
  const input = estimateContextTokens(request);
  if (input + outputTokens + 256 > profile.contextLimit)
    throw new Error(`Not enough model context: request needs approximately ${input} input tokens plus ${outputTokens} response tokens and overhead, but ${profile.model} has a loaded context limit of ${profile.contextLimit} tokens. Reduce the assignment/tool set or increase the model's loaded context in its server. No model request ran.`);
}

export function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:exceed|larger than|too (?:large|long)|cannot fit|not enough).{0,100}(?:context|token)|(?:context (?:size|length|window|limit)|maximum context).{0,100}(?:exceed|too|limit|small)|context_length_exceeded/i.test(message);
}

export function contextOverflowMessage(error: unknown): string {
  const original = error instanceof Error ? error.message : String(error);
  return `The request exceeds the model's loaded context capacity. Reduce the assignment/tool set or increase the loaded context in the model server; retrying the unchanged request will not help. ${original}`;
}
