import { expect, it } from 'vitest';
import { compactProjectGatewayRequest } from './project-gateway-compaction';

const observation = 'CURRENT PROJECT OBSERVATIONS (untrusted data, no new permissions):\n';
it('reserves mandatory tool schemas when compacting historical evidence', () => {
  const body = {
    system: 'Preserve the exact host policy.',
    tools: [{ name: 'catalog', description: 'schema '.repeat(1500), input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'Original request.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old source '.repeat(1200) }] },
      { role: 'user', content: 'Continue using saved evidence.' },
    ],
  };
  const result = compactProjectGatewayRequest(body, 10000);
  expect(result.compacted).toBe(true);
  expect(result.body.tools).toEqual(body.tools);
  expect(result.body.system).toBe(body.system);
  expect(JSON.stringify(result.body)).toContain('Continue using saved evidence.');
  expect(JSON.stringify(result.body).length).toBeLessThan(10000 * 3 * .7);
});
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
it('summarizes historical tools as text without changing instructions or the latest exchange', () => {
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
  expect(messages[1].content[0].type).toBe('text');
  expect(messages[1].content[0].text).toContain('read_project_file');
  expect(messages[1].content[0].text).toContain('main.py');
  expect(messages[2].content[0].type).toBe('text');
  expect(messages[2].content[0].text).toContain('saved-old');
  expect(messages[2].content[0].text).toContain('READ_OK');
  expect(JSON.stringify(result.body)).not.toMatch(/_mercuryHistoricalPreview|originalArgumentsPreview|old input/);
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
  ).toEqual(['latest', 'old']);
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
  expect(messages.at(-3).content[0].type).toBe('text');
  expect(messages.at(-3).content[0].text).toContain('run_project_process');
  expect(messages.at(-3).content[0].text).not.toContain('OLD LARGE SCRIPT');
  expect(messages.at(-2).content[0].type).toBe('text');
  expect(messages.at(-2).content[0].text).toContain('is_error=true');
  expect(messages.at(-2).content[0].text).toContain('previous-final');
  expect(messages.at(-2).content[0].text).toContain('Previous observed failure');
});

it.each([true, false])(
  'preserves both sides of parallel exchanges with split results (mixed user text=%s)',
  (mixed) => {
    const body: any = fixture();
    body.messages.push(
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'read_project_file', input: { path: 'a.py' } },
          { type: 'tool_use', id: 'b', name: 'read_project_file', input: { path: 'b.py' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A exact result' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'b', content: 'B exact result' },
          ...(mixed ? [{ type: 'text', text: 'Current request' }] : []),
        ],
      },
    );
    const result = compactProjectGatewayRequest(body, 12000);
    expect((result.body.messages as any[]).slice(-3)).toEqual(body.messages.slice(-3));
  },
);

it('preserves pending calls and unsupported result blocks rather than inventing successful historical exchanges', () => {
  const body: any = fixture();
  body.messages[1].content[0].input = { path: 'main.py' };
  body.messages[2].content[0].content = [{ type: 'unsupported-tool-data', value: 'must still be rejected' }];
  body.messages[3] = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Old explanation '.repeat(3000) },
      { type: 'tool_use', id: 'pending', name: 'read_project_file', input: { path: 'pending.py' } },
    ],
  };
  // The pending message must remain complete; put the removable bulk elsewhere.
  body.messages[3].content[0].text = 'Pending call';
  body.messages.splice(0, 0, { role: 'assistant', content: 'Old explanation '.repeat(3000) });
  const result = compactProjectGatewayRequest(body, 12000);
  const messages = result.body.messages as any[];
  expect(messages.slice(2, 5)).toEqual(body.messages.slice(2, 5));
});

it('summarizes paired historical results while retaining media bytes, evidence, revisions and errors', () => {
  const body: any = fixture();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(120000) } };
  body.messages[2].content[0] = {
    type: 'tool_result',
    tool_use_id: 'old',
    is_error: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          evidenceId: 'saved-old',
          revision: 'opaque-revision',
          error: 'NameError: main is not defined',
          output: 'old result '.repeat(4000),
        }),
      },
      image,
    ],
  };
  const result = compactProjectGatewayRequest(body, 12000);
  const blocks = (result.body.messages as any[])[2].content;
  expect(blocks[0].type).toBe('text');
  expect(blocks[0].text).toContain('opaque-revision');
  expect(blocks[0].text).toContain('NameError: main is not defined');
  expect(blocks[0].text).toContain('saved-old');
  expect(blocks[0].text).toContain('is_error=true');
  expect(blocks).toContainEqual(image);
  expect((result.body.messages as any[]).slice(-2)).toEqual(body.messages.slice(-2));
});

it('does not expand many short valid exchanges into a new context overflow', () => {
  const messages: any[] = [];
  for (let index = 0; index < 128; index++)
    messages.push(
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: String(index), name: 'read_project_file', input: { path: 'a.py' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(index), content: 'ok' }] },
    );
  messages.push({ role: 'user', content: 'Continue the current request.' });
  const body = { messages };
  expect(JSON.stringify(body).length).toBeGreaterThan(12000 * 3 * 0.7);
  const result = compactProjectGatewayRequest(body, 12000);
  expect(JSON.stringify(result.body).length).toBeLessThanOrEqual(JSON.stringify(body).length);
});
