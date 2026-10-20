import type { ModelConnection, ModelInfo, ModelProfile } from './types';
import { maximumContext } from './model-context';

export const isSubscription = (connection?: ModelConnection): boolean => connection?.provider === 'codex' || (connection?.provider === 'openai' && connection.auth === 'chatgpt');
export const isOpenAIAPI = (connection?: ModelConnection): boolean => connection?.provider === 'openai' && !connection.auth;

export function prioritizeSubscriptions(models: ModelInfo[], connections: ModelConnection[]): ModelInfo[] {
  return [...models].sort((a, b) => Number(isSubscription(connections.find(item => item.id === b.connectionId))) - Number(isSubscription(connections.find(item => item.id === a.connectionId))));
}

/** Only exact model IDs in a saved connection's catalog may change routes. */
export function openAIRoutes(profile: ModelProfile, connections: ModelConnection[], models: ModelInfo[]): ModelProfile[] {
  if (profile.provider !== 'openai' && profile.provider !== 'codex') return [profile];
  const selected = connections.find(item => item.id === profile.connectionId && item.provider === profile.provider);
  if (!selected) return [profile];
  const compatible = connections.filter(connection => (isSubscription(connection) || isOpenAIAPI(connection)) && (connection.id === selected.id || models.some(model => model.connectionId === connection.id && model.provider === connection.provider && model.id === profile.model && model.available)));
  const rank = (connection: ModelConnection) => isSubscription(connection) ? connection.id === selected.id ? 0 : connection.provider === 'openai' ? 1 : 2 : connection.id === selected.id ? 3 : 4;
  return compatible.sort((a, b) => rank(a) - rank(b)).map(connection => {
    const model = models.find(item => item.connectionId === connection.id && item.provider === connection.provider && item.id === profile.model);
    const maximum = maximumContext(model);
    return { ...profile, provider: connection.provider, connectionId: connection.id, endpoint: connection.url, contextLimit: maximum ? Math.min(profile.contextLimit, maximum) : profile.contextLimit };
  });
}
