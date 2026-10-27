// Deterministic injected SDK boundary for host integration tests. Production uses ClaudeProjectRuntime.
import { randomUUID } from 'node:crypto';
import type { ProjectAgentRuntime } from './project-agent-runtime';
import type { ModelProvider } from './providers';

export function projectTestRuntime(provider: ModelProvider): ProjectAgentRuntime {
  return {
    async run(input) {
      const messages: any[] = [...input.messages];
      for (let turn = 0; turn < 32; turn++) {
        input.signal.throwIfAborted();
        const result = await provider.chat({
          profile: input.profile,
          messages,
          tools: input.tools,
          signal: input.signal,
        });
        if (result.text) input.onText?.(result.text);
        if (!result.tools.length) {
          const session = {
            runtime: 'claude-agent-sdk' as const,
            version: 'fixture',
            identity: input.chatId,
            sessionId: randomUUID(),
            status: 'completed' as const,
          };
          input.onSession?.(session);
          return { text: result.text, session };
        }
        messages.push({
          role: 'assistant',
          content: result.text,
          tool_calls: result.tools.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
        const outputs = await Promise.all(
          result.tools.map(async (call) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(await input.execute(call.name, call.arguments)),
          })),
        );
        messages.push(...outputs);
      }
      throw new Error('Fixture model did not finish.');
    },
    async shutdown() {},
  };
}
