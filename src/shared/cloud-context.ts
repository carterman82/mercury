import type { ModelInfo, ProviderKind } from './types';

export interface ContextLimitDetails { tokens: number; source: 'provider' | 'published'; reference?: string; verifiedAt?: string; }
const verifiedAt = '2026-10-20';
const openaiDocs = 'https://developers.openai.com/api/docs/models/';
const claudeDocs = 'https://platform.claude.com/docs/en/models/overview';
const claudeReleaseNotes = 'https://platform.claude.com/docs/en/release-notes/overview';

// Published model windows, not account entitlements or per-request input budgets.
// Exact model IDs prevent similarly named chat, mini, or future variants from
// inheriting a larger window. Update these entries together with their sources.
const openai: Record<string, number> = {
  'gpt-6.1-sol': 1_050_000,
  'gpt-6-astra': 1_050_000,
  'gpt-6-sol': 1_050_000,
  'gpt-6-luna': 1_050_000,
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.2-codex': 400_000,
  'gpt-5.2-chat-latest': 128_000,
  'gpt-5.1': 400_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-5-nano': 400_000,
  'gpt-4.1': 1_047_576,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'chat-latest': 400_000,
  'o3': 200_000,
};
const claude: Record<string, { tokens: number; reference: string }> = {
  'claude-fable-5-1': { tokens: 1_000_000, reference: claudeDocs },
  'claude-opus-5-5': { tokens: 1_000_000, reference: claudeDocs },
  'claude-sonnet-5-5': { tokens: 1_000_000, reference: claudeDocs },
  'claude-haiku-5-5': { tokens: 1_000_000, reference: claudeDocs },
  // The current overview omits legacy models: keep their own specifications too.
  'claude-fable-5': { tokens: 1_000_000, reference: 'https://platform.claude.com/docs/en/models/fable-5/overview' },
  'claude-opus-5': { tokens: 1_000_000, reference: 'https://platform.claude.com/docs/en/models/opus-5/overview' },
  'claude-sonnet-5': { tokens: 1_000_000, reference: 'https://platform.claude.com/docs/en/models/sonnet-5/overview' },
  'claude-opus-4-8': { tokens: 1_000_000, reference: 'https://platform.claude.com/docs/en/models/opus-4-8/overview' },
  'claude-opus-4-7': { tokens: 1_000_000, reference: claudeReleaseNotes },
  'claude-opus-4-6': { tokens: 1_000_000, reference: claudeReleaseNotes },
  'claude-sonnet-4-6': { tokens: 1_000_000, reference: claudeReleaseNotes },
  'claude-opus-4-5': { tokens: 200_000, reference: 'https://platform.claude.com/docs/en/models/opus-4-5/overview' },
  'claude-sonnet-4-5': { tokens: 200_000, reference: claudeReleaseNotes },
  'claude-haiku-4-5': { tokens: 200_000, reference: 'https://platform.claude.com/docs/en/models/haiku-4-5/overview' },
  'claude-sonnet-4': { tokens: 200_000, reference: claudeReleaseNotes },
};
const aliases: Record<string, string> = { 'gpt-5.6': 'gpt-5.6-sol' };

export const validContextLimit = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 2048;

export function publishedContextLimit(provider: ProviderKind, modelId: string): ContextLimitDetails | undefined {
  if (provider === 'ollama' || provider === 'lmstudio') return undefined;
  // Only date suffixes of known IDs are accepted; other aliases need explicit entries.
  let id = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (provider === 'claude') {
    id = id.replace(/-\d{8}$/, '');
    const entry = Object.hasOwn(claude, id) ? claude[id] : undefined;
    return entry ? { ...entry, source: 'published', verifiedAt } : undefined;
  }
  id = Object.hasOwn(aliases, id) ? aliases[id] : id;
  const tokens = Object.hasOwn(openai, id) ? openai[id] : undefined;
  return tokens ? { tokens, source: 'published', reference: openaiDocs + id, verifiedAt } : undefined;
}

export function contextLimitDetails(model?: ModelInfo): ContextLimitDetails | undefined {
  if (!model) return undefined;
  if (validContextLimit(model.contextLimit) && model.contextLimitSource !== 'published') return { tokens: model.contextLimit, source: 'provider' };
  return publishedContextLimit(model.provider, model.id);
}

export function withContextLimit(model: ModelInfo): ModelInfo {
  const context = contextLimitDetails(model);
  return context ? { ...model, contextLimit: context.tokens, contextLimitSource: context.source, contextLimitReference: context.reference, contextLimitVerifiedAt: context.verifiedAt } : model;
}
