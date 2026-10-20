import type { ModelInfo, ModelProfile } from './types';
import { contextLimitDetails } from './cloud-context';

export function maximumContext(model?: ModelInfo): number | undefined {
  return contextLimitDetails(model)?.tokens;
}

export function modelProfile(model: ModelInfo): ModelProfile {
  return { provider: model.provider, connectionId: model.connectionId, model: model.id, contextLimit: maximumContext(model) ?? 8192, contextMode: 'auto' };
}

export function refreshModelContext(profile: ModelProfile, models: ModelInfo[]): ModelProfile {
  // Upgrade the previous automatic defaults; retain explicit custom limits.
  const automatic = profile.contextMode === 'auto' || (!profile.contextMode && [8192, 32768].includes(profile.contextLimit));
  const model = models.find(model => model.connectionId === profile.connectionId && model.id === profile.model && model.provider === profile.provider);
  const maximum = maximumContext(model);
  return automatic && maximum && (maximum !== profile.contextLimit || profile.contextMode !== 'auto') ? { ...profile, contextLimit: maximum, contextMode: 'auto' } : profile;
}
