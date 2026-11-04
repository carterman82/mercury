import { expect, it } from 'vitest';
import { endpointDiagnosticRequest, probeProjectEndpoint } from './project-endpoint-diagnostic';
import { createServer } from 'node:http';
import { once } from 'node:events';

it('bounds approved requests and rejects installers, redirects and streaming', () => {
  expect(() => endpointDiagnosticRequest({ url: 'http://server/install' })).toThrow('Only explicit');
  expect(() => endpointDiagnosticRequest({ url: 'http://user:secret@server/v1/models' })).toThrow('Credentials');
  expect(() => endpointDiagnosticRequest({ url: 'http://server/api/chat', method: 'POST', body: '{"stream":true}' })).toThrow('non-streaming');
  const request = endpointDiagnosticRequest({ url: 'http://server/api/chat', method: 'POST', body: '{"model":"original"}' });
  expect(JSON.parse(request.body!)).toMatchObject({ model: 'original', stream: false, options: { num_predict: 128 } });
});
it('preserves reasoning-only output and HTTP errors without inventing a network cause', async () => {
  const fetcher = (async (_url, init) => { expect(init?.redirect).toBe('error'); return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking' } }] }), { status: 200 }); }) as typeof fetch;
  const result = await probeProjectEndpoint({ url: 'http://server/v1/models' }, new AbortController().signal, fetcher);
  expect(result).toMatchObject({ ran: true, ok: true, summary: { content: '', reasoningCharacters: 8, finishReason: 'length' } });
  const failure = await probeProjectEndpoint({ url: 'http://server/v1/models' }, new AbortController().signal, (async () => new Response('{"error":"wrong model"}', { status: 400 })) as typeof fetch);
  expect(failure).toMatchObject({ ran: true, status: 400, ok: false, summary: { error: 'wrong model' } });
});
it('caps server output and labels a transport failure as unknown usability', async () => {
  const capped = await probeProjectEndpoint({ url: 'http://server/v1/models' }, new AbortController().signal, (async () => new Response('a'.repeat(70000))) as typeof fetch);
  expect(capped.output).toHaveLength(64000); expect(capped).toHaveProperty('truncated', true);
  const unavailable = await probeProjectEndpoint({ url: 'http://server/v1/models' }, new AbortController().signal, (async () => { throw Error('blocked connection'); }) as typeof fetch);
  expect(unavailable).toMatchObject({ ran: true, ok: false, output: 'blocked connection' });
  expect(unavailable.interpretation).toContain('unknown');
});
it('smoke: sends the bounded request to a real loopback model-compatible endpoint', async () => {
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    expect(body).toMatchObject({ model: 'original-qwen', stream: false, max_tokens: 256 });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'diagnostic reply' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const result = await probeProjectEndpoint({ url: `http://127.0.0.1:${port}/v1/chat/completions`, method: 'POST', body: JSON.stringify({ model: 'original-qwen', messages: [{ role: 'user', content: 'Reply briefly' }], max_tokens: 4000 }) }, new AbortController().signal);
    expect(result).toMatchObject({ ran: true, ok: true, summary: { content: 'diagnostic reply', model: 'original-qwen', finishReason: 'stop' } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
