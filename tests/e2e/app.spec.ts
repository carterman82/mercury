import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('chats with individual models, switches models, stops, and restores history', async () => {
  test.setTimeout(60_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-conversation-'));
  const requests: any[] = [];
  let modelListings = 0;
  let finishFormat: (() => void) | undefined;
  const formatted = '# A formatted answer\n\n**Bold** and *italic*, <u>underline</u>, ~~removed~~.\n\n> A useful quote\n\n- First item\n  - Nested item\n\n| Model | Status |\n| --- | --- |\n| Mercury | Ready |\n\n```javascript\nconst total = 42;\n```\n\nMath: $x^2$. [Example](https://example.com)\n\n<script>window.badMarkdown = true</script>';
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') { modelListings++; response.end(JSON.stringify({ models: [{ name: 'echo-one' }, { name: 'echo-two' }] })); return; }
    if (request.url !== '/api/chat') { response.statusCode = 404; response.end('{}'); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    const input = JSON.parse(raw);
    requests.push(input);
    if (input.messages.at(-1).content === 'format') {
      response.write(JSON.stringify({ message: { thinking: 'I will organize the answer into **clear sections** and include a code example.' }, done: false }) + '\n');
      finishFormat = () => response.end(JSON.stringify({ message: { content: formatted }, done: true }) + '\n');
      return;
    }
    if (input.messages.at(-1).content === 'wait') {
      response.write(JSON.stringify({ message: { thinking: 'Partial reasoning' }, done: false }) + '\n');
      return;
    }
    response.end(JSON.stringify({ message: { content: `${input.model} answered` }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const env = { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data };
  let app = await electron.launch({ executablePath, env });
  try {
    let page = await app.firstWindow();
    await page.evaluate(async port => {
      await (window as any).desktop.updateSettings({ connections: [{ id: 'chat-fixture', provider: 'ollama', label: 'Chat fixture', url: `http://127.0.0.1:${port}` }], defaultModel: { provider: 'ollama', connectionId: 'chat-fixture', model: 'echo-one', contextLimit: 8192 }, overrides: {} });
    }, address.port);
    await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled({ timeout: 25_000 });
    await page.getByRole('button', { name: 'Refresh models' }).click();
    await expect(page.getByLabel('Chat model').locator('option').filter({ hasText: 'echo-two' })).toHaveCount(1, { timeout: 25_000 });
    await expect(page.getByRole('button', { name: 'Refresh models' })).toBeEnabled({ timeout: 25_000 });
    await expect(page.locator('.chat-composer').getByLabel('Chat model')).toBeVisible();
    const category = page.getByLabel('Model provider', { exact: true });
    await expect(category).toHaveValue('local');
    await category.selectOption('openai');
    await expect(page.getByLabel('Chat model')).toContainText('Connect OpenAI');
    await expect(page.getByRole('button', { name: 'Send ↑' })).toBeDisabled();
    await category.selectOption('claude');
    await expect(page.getByLabel('Chat model')).toContainText('Connect Claude');
    await page.getByLabel('Chat model').selectOption('__other__');
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
    await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Connect API key' })).toBeDisabled();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await category.selectOption('local');
    await expect(page.locator('.chat-toolbar select')).toHaveCount(0);
    const cachedListings = modelListings;
    for (let index = 0; index < 2; index++) {
      await page.getByRole('button', { name: /Model settings/ }).click();
      await expect(page.getByLabel('Default model').locator('option').filter({ hasText: 'echo-two' })).toHaveCount(1);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }
    expect(modelListings).toBe(cachedListings);
    await page.screenshot({ path: 'test-results/mercury-home.png' });
    await page.getByLabel('Message', { exact: true }).fill('hello');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toContainText('echo-one answered');
    await expect(page.getByLabel('Chat model')).toBeEnabled();
    await page.getByLabel('Chat model').selectOption(JSON.stringify(['chat-fixture', 'echo-two']));
    await page.getByLabel('Message', { exact: true }).fill('follow-up');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant').last()).toContainText('echo-two answered');
    expect(requests[1].messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'echo-one answered' }]));
    expect(requests.every(item => item.tools?.some((tool: any) => tool.function?.name === 'create_pdf'))).toBe(true);
    await expect(page.getByLabel('Chat model')).toBeEnabled();
    await page.getByLabel('Message', { exact: true }).fill('format');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    const richAnswer = page.locator('.chat-assistant').last();
    await expect(richAnswer.locator('.thinking-panel')).toBeVisible();
    await expect(richAnswer.locator('.thinking-panel')).not.toHaveAttribute('open');
    await richAnswer.locator('summary').click();
    await expect(richAnswer.locator('.thinking-body')).toContainText('clear sections');
    await page.screenshot({ path: 'test-results/mercury-thinking.png' });
    finishFormat!();
    await expect(richAnswer.getByRole('heading', { name: 'A formatted answer' })).toBeVisible();
    await expect(richAnswer.locator('u')).toHaveText('underline');
    await expect(richAnswer.locator('table')).toContainText('Mercury');
    await expect(richAnswer.locator('.katex')).toHaveCount(1);
    await expect(richAnswer.locator('.thinking-panel')).toHaveAttribute('open', '');
    await richAnswer.locator('summary').click();
    await expect(richAnswer.locator('script, iframe')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).badMarkdown)).toBeUndefined();
    // Verify the copy payload without touching the user's system clipboard.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedText = text; } } }));
    await richAnswer.getByRole('button', { name: 'Copy code' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copiedText)).toBe('const total = 42;');
    await page.screenshot({ path: 'test-results/mercury-formatted.png' });
    await expect(page.getByLabel('Chat model')).toBeEnabled();
    await page.getByLabel('Message', { exact: true }).fill('wait');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toHaveCount(4);
    await page.locator('.chat-assistant').last().locator('summary').click();
    await expect(page.locator('.chat-assistant').last().locator('.thinking-body')).toContainText('Partial reasoning');
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.getByLabel('Chat model')).toBeEnabled();
    await page.screenshot({ path: 'test-results/mercury-chat.png' });
    await app.close();
    app = await electron.launch({ executablePath, env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'hello', exact: true }).click();
    await page.locator('.chat-assistant').last().locator('summary').click();
    await expect(page.locator('.chat-assistant').last().locator('.thinking-body')).toContainText('Partial reasoning');
    await expect(page.getByLabel('Chat model')).toHaveValue(JSON.stringify(['chat-fixture', 'echo-two']));
    await expect(page.getByLabel('Chat model').locator('option').filter({ hasText: 'echo-two' })).toHaveCount(1);
    expect(modelListings).toBe(cachedListings);
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});

test('desktop shell opens model settings', async () => {
  test.skip(process.platform !== 'win32', 'Windows packaged build smoke test');
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const data = mkdtempSync(path.join(os.tmpdir(), 'local-plan-agent-e2e-'));
  const app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(page.getByRole('heading', { name: 'Models and accounts' })).toBeVisible();
    await page.getByLabel('Default model', { exact: true }).selectOption('__other__');
    await expect(page.getByLabel('Server address')).toBeVisible();
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});

test('finds the shared LM Studio models and verifies streamed tool use', async () => {
  test.setTimeout(60_000);
  test.skip(!process.env.LIVE_TAILSCALE_MODEL, 'Requires the shared Tailscale LM Studio server');
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const data = mkdtempSync(path.join(os.tmpdir(), 'local-plan-agent-live-'));
  const app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(page.locator('.model-grid option').filter({ hasText: /Shared LM Studio.*Qwen3\.8 27B/ }).first()).toHaveCount(1, { timeout: 20_000 });
    await page.getByLabel('Default model', { exact: true }).selectOption(JSON.stringify(['shared-lmstudio', 'qwen3.8-27b-mlx']));
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(page.getByLabel('Default model', { exact: true })).toHaveValue(JSON.stringify(['shared-lmstudio', 'qwen3.8-27b-mlx']));
    const capable = await page.evaluate(() => (window as any).desktop.probe({ provider: 'lmstudio', connectionId: 'shared-lmstudio', model: 'qwen3.8-27b-mlx', contextLimit: 8192 }));
    expect(capable).toBe(true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByLabel('Chat model').selectOption(JSON.stringify(['shared-lmstudio', 'qwen3.8-27b-mlx']));
    await page.getByLabel('Message', { exact: true }).fill('Reply with exactly: Mercury ready');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toContainText('Mercury ready', { timeout: 30_000 });
    await expect(page.locator('.thinking-panel')).toHaveCount(1);
    await expect(page.getByLabel('Chat model')).toBeEnabled();
    await page.screenshot({ path: 'test-results/mercury-live-chat.png' });
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});

test('plans, waits for approval, edits, asks before a command, and restores the session', async () => {
  test.skip(process.platform !== 'win32', 'Windows packaged build workflow test');
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const data = mkdtempSync(path.join(os.tmpdir(), 'local-plan-agent-workflow-'));
  const project = path.join(data, 'fixture');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(project);
  writeFileSync(path.join(project, 'note.txt'), 'old');
  const expectedHash = createHash('sha256').update('old').digest('hex');
  let coderTurn = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== 'Bearer fixture-secret') { response.statusCode = 401; response.end('{}'); return; }
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'fake-local' }] })); return; }
    if (request.url !== '/api/chat') { response.statusCode = 404; response.end('{}'); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk.toString();
    const input = JSON.parse(raw);
    const system = String(input.messages?.[0]?.content ?? '');
    let message: any = { role: 'assistant', content: '' };
    if (input.tools?.some((tool: any) => tool.function?.name === 'probe')) {
      message.tool_calls = [{ function: { name: 'probe', arguments: { value: 'ready' } } }];
    } else if (system.includes('synthesizer')) {
      message.content = JSON.stringify({ objective: 'Update note', assumptions: [], steps: [{ title: 'Update note', details: 'Replace old with new.', checks: ['Run node --version'] }], blockers: [] });
    } else if (system.includes('coder')) {
      coderTurn++;
      message.tool_calls = [coderTurn === 1
        ? { function: { name: 'edit_file', arguments: { path: 'note.txt', expectedHash, content: 'new' } } }
        : coderTurn === 2
          ? { function: { name: 'run_command', arguments: { command: 'node --version' } } }
          : { function: { name: 'finish', arguments: { summary: 'Updated note.', verification: 'node --version passed.' } } }];
    } else message.content = 'Inspect note.txt and replace old with new.';
    response.end(JSON.stringify({ message, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake model server did not start.');
  const env = { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data };
  let app = await electron.launch({ executablePath, env });
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, fixturePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] }); }, project);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: /Open project/ }).click();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await page.getByRole('button', { name: /Other: add a server address/ }).click();
    await page.getByLabel('Server type').selectOption('ollama');
    await page.getByLabel('Name').fill('Fixture server');
    await page.getByLabel('Server address').fill(`http://127.0.0.1:${address.port}`);
    await page.getByLabel('API token (if required)').fill('fixture-secret');
    await page.getByRole('button', { name: 'Check and add' }).click();
    await page.getByLabel('Default model', { exact: true }).selectOption({ label: 'fake-local · Fixture server' });
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByPlaceholder(/Describe the change/).fill('Update note');
    await page.getByRole('button', { name: /Start planning/ }).click();
    await expect(page.locator('.topbar .status')).toHaveText('awaiting review');
    expect(readFileSync(path.join(project, 'note.txt'), 'utf8')).toBe('old');
    await page.getByRole('button', { name: 'Plan', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Objective' })).toHaveValue('Update note');
    await page.getByRole('button', { name: 'Approve and implement' }).click();
    await expect(page.getByRole('heading', { name: 'Run this command?' })).toBeVisible();
    expect(readFileSync(path.join(project, 'note.txt'), 'utf8')).toBe('new');
    await page.getByRole('button', { name: 'Run command' }).click();
    await expect(page.locator('.topbar .status')).toHaveText('completed');
    await app.close();
    app = await electron.launch({ executablePath, env });
    page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(data);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.getByText('Update note', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /Update note.*completed/ }).click();
    await page.getByRole('button', { name: /Changes/ }).click();
    await expect(page.locator('.change').getByText('note.txt')).toBeVisible();
  } finally {
    await app.close();
    server.close();
    rmSync(data, { recursive: true, force: true });
  }
});
