import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIntentOnly } from '../../src/main/answer-completion';

for (const provider of ['ollama', 'lmstudio'] as const) test(`${provider}: finishes announced work and measures the whole response through tools and Subagents`, async () => {
  test.setTimeout(120_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-completion-'));
  let base = '', searches = 0, reads = 0, research = 0;
  const calls = new Map<string, number>();
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'main-model' }, { name: 'research-model' }] })); return; }
    if (request.url?.startsWith('/search?')) {
      searches++; response.setHeader('content-type', 'text/html');
      setTimeout(() => response.end(`<div class="result"><a class="result__a" href="${base}/source">Music report</a><a class="result__snippet">A new album is announced.</a></div>`), 1100); return;
    }
    if (request.url === '/source') {
      reads++; response.setHeader('content-type', 'text/html');
      setTimeout(() => response.end('<title>Music report</title><main>The fixture label announced a new album today.</main>'), 1100); return;
    }
    if (!['/api/chat', '/v1/chat/completions'].includes(request.url ?? '')) { response.end('{}'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const delegated = String(input.messages[0]?.content).startsWith('You are the read-only Subagent');
    const original = input.messages.filter((message: any) => message.role === 'user' && !String(message.content).startsWith('[Mercury continuation')).at(-1)?.content ?? '';
    const key = delegated ? 'research' : String(original);
    const count = (calls.get(key) ?? 0) + 1; calls.set(key, count);
    const results = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    let content = '', reasoning = '', tools: any[] = [], delay = 0;
    const call = (name: string, args: unknown) => tools.push({ id: `call-${count}`, type: 'function', function: { name, arguments: provider === 'ollama' ? args : JSON.stringify(args) } });
    if (delegated) {
      research++;
      if (count === 1) content = 'Let me read the original source.';
      else if (count === 2) call('web_fetch', { url: base + '/source' });
      else {
        if (!JSON.stringify(results).includes('announced a new album')) errors.push('Subagent missed original source');
        content = `The label announced a new album. [Source](${base}/source)`;
      }
    } else if (String(original).startsWith('Latest hip hop news')) {
      if (count === 1) { reasoning = 'I need to consult current sources.'; content = 'Sure!\nLet me pull the latest hip hop news for you.'; }
      else if (count === 2) call('web_search', { query: 'latest hip hop news' });
      else if (count === 3) content = 'Let me review the source documentation.';
      else if (count === 4) call('delegate_task', { task: 'Verify the news in the original source', context: `Read ${base}/source and report what it says.` });
      else {
        if (!JSON.stringify(results).includes('announced a new album')) errors.push('Main missed delegated findings');
        content = `Verified headline: the label announced a new album. [Source](${base}/source)`; delay = 1100;
      }
    } else if (String(original).startsWith('Write the command line')) {
      content = count === 1 ? 'Let me find the correct Windows CLI syntax.' : 'Use PowerShell:\n```powershell\nGet-ChildItem\n```';
    } else if (String(original).startsWith('Find something but keep stopping')) {
      content = 'Let me check the documentation.';
    } else if (String(original).startsWith('Look up a source and wait')) {
      if (count === 1) content = 'Let me find the source.';
      else {
        const chunk = provider === 'ollama' ? { message: { thinking: 'Waiting for the source.' }, done: false } : { choices: [{ delta: { reasoning_content: 'Waiting for the source.' } }] };
        response.write((provider === 'ollama' ? '' : 'data: ') + JSON.stringify(chunk) + '\n\n'); return;
      }
    } else if (String(original).startsWith('Say exactly')) content = 'Let me check the docs.';
    else if (String(original).startsWith('Which tool will you use')) content = "I'll use PowerShell.";
    else if (String(original).startsWith('What did the saved source say')) {
      if (!JSON.stringify(input.messages).includes('announced a new album')) errors.push('Saved source missing on follow-up');
      content = 'The saved source announced a new album.';
    } else { errors.push('Unrecognized fixture prompt: ' + String(original)); content = 'Unexpected fixture prompt.'; }
    const body = provider === 'ollama'
      ? JSON.stringify({ message: { content, ...(reasoning ? { thinking: reasoning } : {}), ...(tools.length ? { tool_calls: tools } : {}) }, done: true }) + '\n'
      : 'data: ' + JSON.stringify({ choices: [{ delta: { content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.length ? { tool_calls: tools.map((tool, index) => ({ ...tool, index })) } : {}) }, finish_reason: tools.length ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n';
    if (delay) setTimeout(() => response.end(body), delay); else response.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const launch = () => electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data, MERCURY_TEST_NETWORK_ORIGIN: base, MERCURY_TEST_WEB_SEARCH: base + '/search' } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(async ({ provider, base }) => window.desktop.updateSettings({ connections: [{ id: 'fixture', provider, label: 'Completion fixture', url: base }], mainModel: { provider, connectionId: 'fixture', model: 'main-model', contextLimit: 65536 }, subagentModel: { provider, connectionId: 'fixture', model: 'research-model', contextLimit: 65536 }, plannerModel: null }), { provider, base });
    const send = async (message: string, fresh = true) => {
      if (fresh) await page.getByRole('button', { name: 'New chat', exact: false }).click();
      await page.getByLabel('Message', { exact: true }).fill(message);
      await page.getByRole('button', { name: 'Send ↑' }).click();
    };
    await send('Latest hip hop news, please.');
    await expect(page.locator('.thinking-panel summary')).toContainText(/Working for [1-9]\d*s/, { timeout: 20_000 });
    await expect(page.locator('.chat-assistant')).toContainText('Verified headline:', { timeout: 40_000 });
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const chat = snapshot.chats[0], reply = chat.messages.at(-1)!;
    expect(chat.status).toBe('idle'); expect(searches).toBe(1); expect(reads).toBe(1); expect(research).toBe(3);
    expect(reply.completedAt! - reply.startedAt!).toBeGreaterThanOrEqual(3300);
    expect(reply.completedAt! - reply.thinkingEndedAt!).toBeGreaterThanOrEqual(3300);
    const duration = Math.floor((reply.completedAt! - reply.startedAt!) / 1000);
    await expect(page.locator('.thinking-panel summary')).toContainText(`Worked for ${duration}s`);
    await expect(page.locator('.chat-assistant')).not.toContainText('Thought for');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: 'Latest hip hop news, please.', exact: true }).click();
    await expect(page.locator('.thinking-panel summary')).toContainText(`Worked for ${duration}s`);
    await send('What did the saved source say?', false);
    await expect(page.locator('.chat-assistant').last()).toContainText('The saved source announced a new album.');
    expect(searches).toBe(1); expect(reads).toBe(1);

    await send('Write the command line to list all files.');
    await expect(page.locator('.chat-assistant')).toContainText('Get-ChildItem');
    expect(calls.get('Write the command line to list all files.')).toBe(2);
    await expect(page.locator('.thinking-panel summary')).toContainText('Worked for');

    await send('Say exactly "Let me check the docs."');
    await expect(page.locator('.chat-assistant .chat-message-content')).toHaveText('Let me check the docs.');
    expect(calls.get('Say exactly "Let me check the docs."')).toBe(1);
    await send('Which tool will you use to list files?');
    await expect(page.locator('.chat-assistant .chat-message-content')).toHaveText("I'll use PowerShell.");
    expect(calls.get('Which tool will you use to list files?')).toBe(1);

    await send('Find something but keep stopping before the answer.');
    await expect(page.locator('.chat-messages [role="alert"]')).toContainText('two continuation attempts');
    expect(calls.get('Find something but keep stopping before the answer.')).toBe(3);
    expect((await page.evaluate(() => window.desktop.snapshot())).chats[0].status).toBe('failed');

    await send('Look up a source and wait for me to stop.');
    await expect.poll(() => calls.get('Look up a source and wait for me to stop.')).toBe(2);
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.getByRole('button', { name: 'Send ↑' })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).chats[0].status).toBe('stopped');
    expect(calls.get('Look up a source and wait for me to stop.')).toBe(2);
    expect(errors).toEqual([]);
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(data, { recursive: true, force: true }); }
});

test('live model answers Windows commands and current news instead of ending with an announcement', async () => {
  test.skip(!process.env.MERCURY_LIVE_MODEL || !process.env.MERCURY_LIVE_URL, 'Opt-in actual model and public-web evaluation.');
  test.setTimeout(360_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-live-completion-'));
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ url, model }) => window.desktop.updateSettings({ connections: [{ id: 'live', provider: 'lmstudio', label: 'Live model', url }], mainModel: { provider: 'lmstudio', connectionId: 'live', model, contextLimit: 32768 }, plannerModel: null, subagentModel: null }), { url: process.env.MERCURY_LIVE_URL!, model: process.env.MERCURY_LIVE_MODEL! });
    const send = async (request: string) => {
      await page.getByRole('button', { name: 'New chat', exact: false }).click();
      await page.getByLabel('Message', { exact: true }).fill(request);
      await page.getByRole('button', { name: 'Send ↑' }).click();
      await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chats[0]?.status, { timeout: 165_000 }).not.toBe('streaming');
      const chat = (await page.evaluate(() => window.desktop.snapshot())).chats[0];
      console.log(JSON.stringify({ request, status: chat.status, error: chat.error, answer: chat.messages.at(-1)?.content, tools: chat.messages.at(-1)?.toolActivity?.map(item => ({ name: item.name, status: item.status })) }));
      expect(chat.status, chat.error).toBe('idle');
      const reply = chat.messages.at(-1)!;
      expect(isIntentOnly(reply.content, request)).toBe(false);
      expect(reply.completedAt! - reply.startedAt!).toBeGreaterThan(0);
      return reply;
    };
    const commands = await send('Give me the Windows PowerShell commands to show my current folder and list files. Include a short explanation for each. Do not run commands or create files.');
    expect(commands.content).toMatch(/Get-Location|\bpwd\b/i);
    expect(commands.content).toMatch(/Get-ChildItem|\bdir\b|\bls\b/i);
    const news = await send('What is the latest hip hop news? Check the web and give two brief sourced headlines with dates. Do not install plugins.');
    expect(news.content.length).toBeGreaterThan(100);
    expect(news.content).toMatch(/https?:\/\//);
    expect(news.sourceEvidence?.some(item => item.tool === 'web_search')).toBe(true);
    expect(news.sourceEvidence?.some(item => item.tool === 'web_fetch')).toBe(true);
    await page.screenshot({ path: 'test-results/mercury-live-completion.png' });
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});
