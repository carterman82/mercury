import { expect, it } from 'vitest';
import { connectionGroups } from './connections';
import type { ModelConnection, ModelInfo } from './types';

it('groups local servers by device while keeping cloud accounts and identical model names distinct', () => {
  const connections: ModelConnection[] = [
    { id: 'local-one', provider: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234' },
    { id: 'local-two', provider: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434' },
    { id: 'remote-one', provider: 'lmstudio', label: 'Shared', url: 'http://100.80.53.57:1234', deviceId: '100.80.53.57', deviceLabel: 'Desktop (Tailscale)' },
    { id: 'remote-two', provider: 'ollama', label: 'Shared Ollama', url: 'http://100.80.53.57:11434' },
    { id: 'manual', provider: 'lmstudio', label: 'Manual', url: 'http://WORKSTATION.:1234' },
    { id: 'manual-two', provider: 'ollama', label: 'Manual Ollama', url: 'http://workstation:11434' },
    { id: 'account-one', provider: 'openai', label: 'ChatGPT', url: 'https://api.openai.com', auth: 'chatgpt' },
    { id: 'account-two', provider: 'openai', label: 'OpenAI API', url: 'https://api.openai.com' },
    { id: 'claude', provider: 'claude', label: 'Claude', url: 'https://api.anthropic.com' },
  ];
  const models: ModelInfo[] = connections.map(connection => ({ id: 'same-model', label: 'Same model', connectionId: connection.id, connectionLabel: connection.label, provider: connection.provider, available: true }));
  const groups = connectionGroups(connections, models);
  expect(groups).toHaveLength(6);
  expect(groups[0].label).toBe('This computer');
  expect(groups[0].connections).toHaveLength(2);
  expect(groups[1].label).toBe('Desktop (Tailscale)');
  expect(groups[1].models.map(model => model.connectionId)).toEqual(['remote-one', 'remote-two']);
  expect(groups[2].connections).toHaveLength(2);
  expect(groups.flatMap(group => group.models)).toHaveLength(connections.length);
});
