import { expect, it } from 'vitest';
import { LocalProviders } from './providers';

const endpoint = process.env.MERCURY_LOOP_LIVE_ENDPOINT;
it.skipIf(!endpoint)(
  'smokes both guarded transports against the configured Qwen Coder Next server',
  async () => {
    const profile = {
      provider: 'lmstudio' as const,
      connectionId: 'live',
      model: 'qwen/qwen3-coder-next',
      contextLimit: 262144,
    };
    const provider = new LocalProviders(() => ({
      connections: [{ id: 'live', provider: 'lmstudio', label: 'Live', url: endpoint! }],
      mainModel: profile,
      subagentModel: null,
      plannerModel: null,
    }));
    const messages = [{ role: 'user', content: 'Reply exactly with MERCURY_LOOP_SMOKE_OK. No other text.' }];
    const signal = AbortSignal.timeout(60000);
    const result = await provider.chat({
      profile,
      messages,
      tools: [],
      toolChoice: { type: 'none' },
      maxOutputTokens: 64,
      signal,
    });
    expect(result.text).toContain('MERCURY_LOOP_SMOKE_OK');
    expect(result.reasoning ?? '').toBe('');
    expect(result.tools).toEqual([]);
    const response = await provider.messages({
      profile,
      body: { messages, stream: true, max_tokens: 64, thinking: { type: 'disabled' }, tool_choice: { type: 'none' } },
      signal,
    });
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    const events = (await response!.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.map((event) => event.delta?.text ?? '').join('')).toContain('MERCURY_LOOP_SMOKE_OK');
    expect(events.some((event) => event.type === 'message_stop')).toBe(true);
    expect(provider.requestCounts).toEqual([]);
  },
  65000,
);
