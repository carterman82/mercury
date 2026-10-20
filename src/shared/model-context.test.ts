import { expect, it } from 'vitest';
import { maximumContext, modelProfile, refreshModelContext } from './model-context';
import { modelCategory, type ModelInfo } from './types';

const model: ModelInfo = { provider: 'lmstudio', connectionId: 'remote', connectionLabel: 'Remote', id: 'model', label: 'Model', available: true, contextLimit: 1_048_576 };
it('uses the model maximum without the previous 8192/32768 caps', () => {
  expect(modelProfile(model)).toMatchObject({ contextLimit: 1_048_576, contextMode: 'auto' });
  expect(modelProfile({ ...model, contextLimit: 131072 }).contextLimit).toBe(131072);
  expect(maximumContext({ ...model, contextLimit: NaN })).toBeUndefined();
  expect(modelProfile({ ...model, contextLimit: undefined }).contextLimit).toBe(8192);
});
it('upgrades old automatic defaults and preserves manually chosen limits', () => {
  const profile = modelProfile(model);
  expect(refreshModelContext({ ...profile, contextLimit: 8192, contextMode: undefined }, [model]).contextLimit).toBe(model.contextLimit);
  expect(refreshModelContext({ ...profile, contextLimit: 32768, contextMode: 'manual' }, [model]).contextLimit).toBe(32768);
  expect(refreshModelContext({ ...profile, contextLimit: 16384, contextMode: undefined }, [model]).contextLimit).toBe(16384);
});
it('puts Codex and ChatGPT models in one provider category while retaining their routes', () => {
  expect(modelCategory('codex')).toBe(modelCategory('openai'));
  expect(modelProfile({ ...model, provider: 'codex' }).provider).toBe('codex');
});
