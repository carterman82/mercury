import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const task = 'Fix clamp.mjs so clamp(value, min, max) bounds the value inclusively. Preserve keep.txt. Read source, edit it, and verify with the supplied tests.';
const original = 'export const clamp = (value, min, max) => Math.min(max, Math.max(max, value));\n';
const tests = `import assert from 'node:assert/strict';\nimport { clamp } from './clamp.mjs';\nfor (const [v,min,max,want] of [[3,0,10,3],[-2,0,10,0],[20,0,10,10],[0,0,10,0],[10,0,10,10],[-3,-8,-1,-3]]) assert.equal(clamp(v,min,max),want);\n`;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Adapter code is trusted local code, not a sandbox. Supplied tools are limited to
 * a fresh fixture. No shell commands, production repository or saved credentials. */
export async function evaluate(adapter, { timeoutMs = 30_000, signal, kind = 'external-adapter' } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Evaluation timeout must be 1–600000 ms.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-eval-'));
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error('Evaluation timed out.')), timeoutMs);
  const started = performance.now();
  const reads = new Set();
  const metrics = { toolCalls: 0, repeatedReads: 0, testRuns: 0, testsPassed: false, cancelled: false, elapsedMs: 0, tokens: null, changedFiles: [], unexpectedEdits: [], completed: false };
  let outcome = 'failed';
  const resolve = name => {
    if (!['clamp.mjs', 'keep.txt'].includes(name)) throw new Error('Only fixture source files are available.');
    controller.signal.throwIfAborted();
    return path.join(root, name);
  };
  const test = async () => {
    controller.signal.throwIfAborted(); metrics.toolCalls++; metrics.testRuns++;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['test.mjs'], { cwd: root, windowsHide: true, stdio: 'ignore', signal: controller.signal, env: {} });
      child.once('error', reject);
      child.once('close', code => resolve(code === 0));
    });
  };
  try {
    await fs.writeFile(path.join(root, 'clamp.mjs'), original);
    await fs.writeFile(path.join(root, 'keep.txt'), 'preserve me\n');
    await fs.writeFile(path.join(root, 'test.mjs'), tests);
    const tools = {
      read: async name => {
        const filename = resolve(name); metrics.toolCalls++;
        const content = await fs.readFile(filename, 'utf8');
        const revision = `${name}:${hash(content)}`;
        if (reads.has(revision)) metrics.repeatedReads++;
        reads.add(revision); return content;
      },
      write: async (name, content) => {
        const filename = resolve(name); metrics.toolCalls++;
        if (typeof content !== 'string' || Buffer.byteLength(content) > 64_000) throw new Error('Edit exceeds fixture bounds.');
        await fs.writeFile(filename, content);
      },
      test,
    };
    let removeAbort;
    const cancelled = new Promise((_, reject) => {
      const stop = () => reject(controller.signal.reason ?? new Error('Cancelled'));
      removeAbort = () => controller.signal.removeEventListener('abort', stop);
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    let result;
    try { result = await Promise.race([Promise.resolve().then(() => adapter({ task, tools, signal: controller.signal })), cancelled]); }
    finally { removeAbort(); }
    if (result?.usage && ['input', 'output'].every(key => Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0)) metrics.tokens = { input: result.usage.input, output: result.usage.output };
    metrics.testsPassed = await test();
    for (const name of ['clamp.mjs', 'keep.txt']) {
      const expected = name === 'clamp.mjs' ? original : 'preserve me\n';
      if (await fs.readFile(path.join(root, name), 'utf8') !== expected) metrics.changedFiles.push(name);
    }
    metrics.unexpectedEdits = metrics.changedFiles.filter(name => name !== 'clamp.mjs');
    metrics.completed = metrics.testsPassed && metrics.changedFiles.includes('clamp.mjs') && !metrics.unexpectedEdits.length;
    outcome = metrics.completed ? 'passed' : 'failed';
  } catch {
    metrics.cancelled = controller.signal.aborted;
    outcome = metrics.cancelled ? 'cancelled' : 'failed';
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    metrics.elapsedMs = Math.round(performance.now() - started);
    await fs.rm(root, { recursive: true, force: true });
  }
  return { taskId: 'clamp-bounds-v1', kind, outcome, metrics };
}

export async function fixtureAdapter({ tools, signal }) {
  signal.throwIfAborted();
  const source = await tools.read('clamp.mjs');
  await tools.write('clamp.mjs', source.replace('Math.max(max, value)', 'Math.max(min, value)'));
  await tools.test();
}
