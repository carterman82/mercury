import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fixtureAdapter } from './evaluate.mjs';
import { createServer } from 'node:http';
import mercuryLocalAdapter from './mercury-local-adapter.mjs';

test('fixture adapter repairs real code and passes external tests', async () => {
  const result = await evaluate(fixtureAdapter, { kind: 'deterministic-harness-fixture' });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.metrics.changedFiles, ['clamp.mjs']);
  assert.equal(result.metrics.testRuns, 2);
  assert.equal(result.metrics.tokens, null);
});
test('claims of completion cannot substitute for tests; repeated reads are counted', async () => {
  const result = await evaluate(async ({ tools }) => { await tools.read('clamp.mjs'); await tools.read('clamp.mjs'); return { completed: true }; });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.metrics.repeatedReads, 1);
  assert.equal(result.metrics.testsPassed, false);
});
test('unrelated edits fail even when implementation tests pass', async () => {
  const result = await evaluate(async input => { await fixtureAdapter(input); await input.tools.write('keep.txt', 'changed'); });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.metrics.unexpectedEdits, ['keep.txt']);
});
test('timeout cancels bounded tool access and reports cancellation', async () => {
  const result = await evaluate(async () => new Promise(() => {}), { timeoutMs: 25 });
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.metrics.cancelled, true);
});

test('local adapter exercises actual Mercury provider calls against a controlled server', async () => {
  const original = { adapter: process.env.MERCURY_EVAL_ADAPTER, model: process.env.MERCURY_EVAL_MODEL, provider: process.env.MERCURY_EVAL_PROVIDER, endpoint: process.env.MERCURY_EVAL_ENDPOINT };
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    const step = requests.length;
    const calls = step === 1 ? [{ function: { name: 'read', arguments: { name: 'clamp.mjs' } } }]
      : step === 2 ? [{ function: { name: 'write', arguments: { name: 'clamp.mjs', content: 'export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));\n' } } }]
      : step === 3 ? [{ function: { name: 'test', arguments: {} } }] : [];
    response.end(JSON.stringify({ message: { content: calls.length ? '' : 'Done', tool_calls: calls }, done: true, prompt_eval_count: 10, eval_count: 5 }) + '\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.MERCURY_EVAL_MODEL = 'controlled-fixture'; process.env.MERCURY_EVAL_PROVIDER = 'ollama';
  process.env.MERCURY_EVAL_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await evaluate(mercuryLocalAdapter, { kind: 'controlled-provider-fixture' });
    assert.equal(result.outcome, 'passed');
    assert.equal(requests.length, 4);
    assert.deepEqual(result.metrics.tokens, { input: 40, output: 20 });
    assert.equal(requests[0].model, 'controlled-fixture');
    assert.equal(requests[0].tools.length, 3);
  } finally {
    for (const [key, value] of Object.entries({ MERCURY_EVAL_ADAPTER: original.adapter, MERCURY_EVAL_MODEL: original.model, MERCURY_EVAL_PROVIDER: original.provider, MERCURY_EVAL_ENDPOINT: original.endpoint })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
