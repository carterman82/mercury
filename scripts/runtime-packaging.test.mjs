import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import config from '../forge.config.ts';

test('copies a loadable jsdom dependency closure including npm packages with builtin names', async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-runtime-package-'));
  t.after(() => fs.rm(stage, { recursive: true, force: true, maxRetries: 3 }));
  await config.hooks.packageAfterCopy(config, stage);
  const packagedRequire = createRequire(path.join(stage, 'package.json'));
  const { JSDOM } = packagedRequire('jsdom');
  const dom = new JSDOM('<p>packaged runtime works</p>');
  assert.equal(dom.window.document.querySelector('p').textContent, 'packaged runtime works');
  dom.window.close();
  assert.ok(packagedRequire.resolve('punycode/').startsWith(stage));
});
