import type { ModelProfile, Settings } from './types';

export const isLocalModel = (profile: ModelProfile) => profile.provider === 'lmstudio' || profile.provider === 'ollama';
export const sameModel = (a: ModelProfile, b: ModelProfile) => a.provider === b.provider && a.connectionId === b.connectionId && a.model === b.model;
export function roleModels(settings: Settings, role: 'main' | 'subagent', fallback = settings.mainModel): ModelProfile[] {
  const first = (role === 'main' ? settings.mainModel : settings.subagentModel) ?? fallback;
  if (!first) return [];
  return [first, ...(isLocalModel(first) ? (role === 'main' ? settings.additionalMainModels : settings.additionalSubagentModels) ?? [] : [])];
}
