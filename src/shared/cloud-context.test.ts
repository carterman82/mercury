import { expect, it } from 'vitest';
import { contextLimitDetails, publishedContextLimit, withContextLimit } from './cloud-context';
import { modelProfile, refreshModelContext } from './model-context';
import type { ModelInfo } from './types';

const model: ModelInfo = { provider: 'openai', connectionId: 'api', connectionLabel: 'API', id: 'gpt-6.1-sol', label: 'GPT', available: true };

it.each([
  ['claude-sonnet-5', 1_000_000], ['claude-opus-5', 1_000_000], ['claude-fable-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000], ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-5', 200_000], ['claude-haiku-4-5', 200_000],
] as const)('resolves legacy Claude %s and upgrades its old automatic fallback', (id, tokens) => {
  const claude: ModelInfo = { ...model, provider: 'claude', id };
  expect(publishedContextLimit('claude', id)).toMatchObject({ tokens, source: 'published', reference: expect.stringContaining('platform.claude.com') });
  expect(publishedContextLimit('claude', id + '-20260101')?.tokens).toBe(tokens);
  expect(modelProfile(claude).contextLimit).toBe(tokens);
  const old = { ...modelProfile(claude), contextLimit: 8192 };
  expect(refreshModelContext(old, [claude]).contextLimit).toBe(tokens);
  expect(refreshModelContext({ ...old, contextMode: 'manual' }, [claude]).contextLimit).toBe(8192);
  expect(withContextLimit({ ...claude, contextLimit: 128_000 })).toMatchObject({ contextLimit: 128_000, contextLimitSource: 'provider' });
});

it('does not guess limits for unknown Claude variants', () => {
  for (const id of ['claude-sonnet-5-unknown', 'claude-sonnet-99', 'claude-opus-4-9', 'constructor']) expect(publishedContextLimit('claude', id)).toBeUndefined();
});

it('resolves verified exact cloud models and dated snapshots without confusing variants', () => {
  expect(publishedContextLimit('openai', 'gpt-6.1-sol-2026-10-20')).toMatchObject({ tokens: 1_050_000, source: 'published', verifiedAt: '2026-10-20' });
  expect(publishedContextLimit('codex', 'gpt-5.3-codex')?.tokens).toBe(400_000);
  expect(publishedContextLimit('openai', 'gpt-5.4')?.tokens).toBe(1_050_000);
  expect(publishedContextLimit('openai', 'gpt-5.4-mini')?.tokens).toBe(400_000);
  expect(publishedContextLimit('openai', 'gpt-5.2-chat-latest')?.tokens).toBe(128_000);
  expect(publishedContextLimit('claude', 'claude-sonnet-4-5-20250929')?.tokens).toBe(200_000);
  expect(publishedContextLimit('claude', 'claude-sonnet-4-6')?.tokens).toBe(1_000_000);
  for (const id of ['gpt-99', 'gpt-5.4-unknown', 'constructor', 'astra-account-slug']) expect(publishedContextLimit('openai', id)).toBeUndefined();
  expect(publishedContextLimit('lmstudio', model.id)).toBeUndefined();
});

it('prefers actual connection metadata, including smaller account windows', () => {
  expect(contextLimitDetails({ ...model, contextLimit: 32_768 })).toEqual({ tokens: 32_768, source: 'provider' });
  expect(withContextLimit({ ...model, contextLimit: 0 })).toMatchObject({ contextLimit: 1_050_000, contextLimitSource: 'published' });
  expect(withContextLimit({ ...model, contextLimit: 400_000, contextLimitSource: 'published' }).contextLimit).toBe(1_050_000);
  expect(contextLimitDetails({ ...model, id: 'unknown', label: model.id })).toBeUndefined();
});

it('uses the catalog for automatic profiles while preserving explicit manual choices', () => {
  expect(modelProfile(model).contextLimit).toBe(1_050_000);
  const legacy = { ...modelProfile(model), contextLimit: 8192, contextMode: undefined };
  expect(refreshModelContext(legacy, [model]).contextLimit).toBe(1_050_000);
  const manual = { ...legacy, contextLimit: 16_384, contextMode: 'manual' as const };
  expect(refreshModelContext(manual, [model])).toEqual(manual);
  expect(modelProfile({ ...model, id: 'unknown' }).contextLimit).toBe(8192);
});
