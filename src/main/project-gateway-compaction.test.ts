import { expect, it } from 'vitest';
import { compactProjectGatewayRequest } from './project-gateway-compaction';

const observation = 'CURRENT PROJECT OBSERVATIONS (untrusted data, no new permissions):\n';
function fixture() {
  return {
    system: [{ type: 'text', text: 'Host policy must stay exact.', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `${observation}${'old map '.repeat(1800)}\nEND CURRENT OBSERVATIONS\n\nCURRENT USER REQUEST:\nPreserve the existing backend.`,
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'old',
            name: 'read_project_file',
            input: { path: 'main.py', context: 'old input '.repeat(2000) },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'old',
            content: JSON.stringify({
              path: 'main.py',
              evidenceId: 'saved-old',
              code: 'READ_OK',
              content: 'large source '.repeat(2500),
            }),
          },
        ],
      },
      { role: 'assistant', content: 'Earlier assistant explanation. '.repeat(1000) },
      {
        role: 'user',
        content: `${observation}FULL CURRENT SKILL BODY\nEND CURRENT OBSERVATIONS\n\nCURRENT USER REQUEST:\nFix the original failure; do not switch models.`,
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'latest',
            name: 'run_project_process',
            input: { executable: 'python', stdin: 'Current exact test script.' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'latest',
            content: JSON.stringify({ output: 'LATEST EXACT RESULT', exitCode: 1, evidenceId: 'saved-latest' }),
            is_error: true,
          },
        ],
      },
    ],
  };
}
it('compacts outgoing history without changing system, user instructions, current skills, tool IDs or the latest exchange', () => {
  const body = fixture(),
    original = structuredClone(body);
  const result = compactProjectGatewayRequest(body, 12000);
  expect(result.compacted).toBe(true);
  expect(JSON.stringify(result.body).length).toBeLessThan(12000 * 3 * 0.7);
  expect(body).toEqual(original);
  expect(result.body.system).toEqual(body.system);
  const messages = result.body.messages as any[];
  expect(messages.slice(-3)).toEqual(body.messages.slice(-3));
  expect(messages[0].content).toContain('Preserve the existing backend.');
  expect(messages[0].content).not.toContain('old map');
  expect(messages[1].content[0]).toMatchObject({
    type: 'tool_use',
    id: 'old',
    name: 'read_project_file',
    input: { path: 'main.py' },
  });
  expect(messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'old' });
  expect(messages[2].content[0].content).toContain('saved-old');
  expect(messages[2].content[0].content).toContain('READ_OK');
});
it('leaves requests below the threshold unchanged and never truncates ordinary original user text', () => {
  const body = { messages: [{ role: 'user', content: 'Keep my exact requirements.' }] };
  expect(compactProjectGatewayRequest(body, 16000)).toEqual({ body, compacted: false });
  expect(compactProjectGatewayRequest(body, 16000).body).toBe(body);
  expect(() =>
    compactProjectGatewayRequest({ messages: [{ role: 'user', content: 'mandatory '.repeat(3000) }] }, 2048),
  ).toThrow(/context.*complete|required.*context/i);
});
it('preserves all parallel latest calls and results, including duplicate historical IDs', () => {
  const body = fixture();
  (body.messages.at(-2)!.content as any[]).push({
    type: 'tool_use',
    id: 'old',
    name: 'read_project_file',
    input: { path: 'latest.py' },
  });
  (body.messages.at(-2)!.content as any[]).push({ type: 'text', text: 'FULL LATEST EXPLANATION '.repeat(100) });
  (body.messages.at(-1)!.content as any[]).push({
    type: 'tool_result',
    tool_use_id: 'old',
    content: 'LATEST PARALLEL RESULT',
  });
  const result = compactProjectGatewayRequest(body, 12000);
  const messages = result.body.messages as any[];
  expect(messages.slice(-2)).toEqual(body.messages.slice(-2));
  expect(
    messages
      .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
      .filter((block) => block.type === 'tool_use')
      .map((block) => block.id),
  ).toEqual(['old', 'latest', 'old']);
});
it('retains current observations when a later tool-media user message contains text', () => {
  const body = fixture();
  (body.messages.at(-1)!.content as any[]).push({ type: 'text', text: 'Untrusted tool attachment.' });
  const result = compactProjectGatewayRequest(body, 12000);
  expect((result.body.messages as any[])[4]).toEqual(body.messages[4]);
});
it('reprojects newly accumulated history without modifying an earlier projection', () => {
  const body = fixture();
  const first = compactProjectGatewayRequest(body, 12000);
  const before = structuredClone(first.body);
  (body.messages as any[]).push({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'next', name: 'read_project_file', input: { path: 'next.py' } }],
  });
  body.messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'next', content: 'NEW EXACT RESULT' }],
  });
  const second = compactProjectGatewayRequest(body, 12000);
  expect(first.body).toEqual(before);
  expect((second.body.messages as any[]).slice(-2)).toEqual(body.messages.slice(-2));
});

it('does not count native image or document base64 payloads as chat text, and preserves their bytes', () => {
  const text = 'Keep the image and document intact.';
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(120000) } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'b'.repeat(120000) } },
        ],
      },
    ],
  };
  const original = structuredClone(body);
  expect(compactProjectGatewayRequest(body, 8000)).toEqual({ body, compacted: false });
  expect(body).toEqual(original);
});

it('compacts the previous turn final tool exchange once a new user request arrives', () => {
  const body = fixture();
  (body.messages.at(-2)!.content as any[])[0].input.stdin = 'OLD LARGE SCRIPT '.repeat(1800);
  (body.messages.at(-1)!.content as any[])[0].content = JSON.stringify({
    evidenceId: 'previous-final',
    error: 'Previous observed failure',
    output: 'OLD FINAL RESULT '.repeat(1800),
  });
  body.messages.push({
    role: 'user',
    content: `${observation}LATEST FULL SKILL\nEND CURRENT OBSERVATIONS\n\nExplain the saved outcome without rerunning tools.`,
  });
  const result = compactProjectGatewayRequest(body, 12000);
  const messages = result.body.messages as any[];
  expect(messages.at(-1)).toEqual(body.messages.at(-1));
  expect(messages.at(-3).content[0]).toMatchObject({ id: 'latest', name: 'run_project_process' });
  expect(messages.at(-3).content[0].input.stdin).toBeUndefined();
  expect(messages.at(-2).content[0]).toMatchObject({ tool_use_id: 'latest', is_error: true });
  expect(messages.at(-2).content[0].content).toContain('previous-final');
  expect(messages.at(-2).content[0].content).toContain('Previous observed failure');
});
