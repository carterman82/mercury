/** Internal control flow, distinct from user cancellation and provider failures. */
export class ProjectContextRollover extends Error {
  constructor(readonly reason: 'context' | 'turns' = 'context') {
    super(reason === 'turns' ? 'Session step limit reached; saving a handoff before continuing.' : 'Context reached 90%; saving a handoff before the next agent step.');
  }
}

/** Conservative text estimate, including tool schemas; binary payloads are not text tokens. */
export function estimateProjectRequestTokens(body: Record<string, unknown>): number {
  const text = JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }, (_key, value) =>
    value?.source?.type === 'base64' ? { ...value, source: { ...value.source, data: '' } } : value,
  );
  return Math.ceil(text.length / 3);
}
