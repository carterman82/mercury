import type { ModelConnection, ModelInfo } from './types';

export interface ConnectionGroup { id: string; label: string; connections: ModelConnection[]; models: ModelInfo[]; }

export function connectionGroups(connections: ModelConnection[], models: ModelInfo[]): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();
  for (const connection of connections) {
    const cloud = connection.provider === 'openai' || connection.provider === 'claude' || connection.provider === 'codex';
    let host: string;
    try { host = new URL(connection.url).hostname.toLowerCase().replace(/\.$/, ''); }
    catch { host = connection.id; }
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
    const id = cloud ? `account:${connection.id}` : local ? 'device:this-computer' : `device:${connection.deviceId ?? host}`;
    const label = cloud ? connection.label : local ? 'This computer' : connection.deviceLabel ?? (/\(Tailscale\)|^tailscale-|^shared-lmstudio/.test(connection.label + connection.id) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ? `${host} (Tailscale)` : host);
    const group = groups.get(id) ?? { id, label, connections: [], models: [] };
    group.connections.push(connection);
    group.models.push(...models.filter(model => model.connectionId === connection.id));
    groups.set(id, group);
  }
  return [...groups.values()];
}
