import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('searches and reads without a browser, supports delegated research, and retains sources', async () => {
  test.setTimeout(90_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-http-search-'));
  let base = '', searches = 0, reads = 0, subagents = 0;
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'search-model' }] })); return; }
    if (request.url?.startsWith('/search?')) {
      searches++; response.setHeader('content-type', 'text/html');
      response.end(`<div class="result"><a class="result__a" href="${base}/source">Official report</a><a class="result__snippet">The latest report.</a></div>`); return;
    }
    if (request.url === '/source') {
      reads++; response.setHeader('content-type', 'text/html');
      response.end('<title>Official report</title><main>The recorded total is 721.</main><script>throw new Error("Must never execute")</script>'); return;
    }
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (!Array.isArray(input.messages)) { response.end('{}'); return; }
    const system = input.messages[0]?.content ?? '';
    const research = system.includes('read-only Subagent');
    const user = input.messages.filter((message: any) => message.role === 'user').at(-1)?.content ?? '';
    const results = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    const calls: any[] = []; let content = '';
    const call = (name: string, args: unknown) => calls.push({ function: { name, arguments: args } });
    if (!input.tools?.some((tool: any) => tool.function.name === 'web_search')) errors.push('Search tool missing');
    if (research && !results.length) subagents++;
    if (String(user).startsWith('Recall')) {
      if (!JSON.stringify(input.messages).includes('721')) errors.push('Saved source missing');
      content = `The saved total is 721. [Source](${base}/source)`;
    } else if (!research && String(user).startsWith('Delegate')) {
      if (!results.length) call('delegate_task', { task: 'Find and verify the report total', context: 'Search the public web and read the original source.' });
      else { if (!JSON.stringify(results).includes('721')) errors.push('Research findings missing'); content = `Subagent verified 721. [Source](${base}/source)`; }
    } else if (!results.length) call('web_search', { query: 'official report', count: 3 });
    else if (results.length === 1) {
      if (results[0].results?.[0]?.url !== base + '/source') errors.push('Search URL missing');
      call('web_fetch', { url: base + '/source' });
    } else {
      if (!results.at(-1)?.content?.includes('721')) errors.push('Original source not read');
      content = `Verified total 721. [Source](${base}/source)`;
    }
    response.end(JSON.stringify({ message: { content, ...(calls.length ? { tool_calls: calls } : {}) }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data, MERCURY_TEST_NETWORK_ORIGIN: base, MERCURY_TEST_WEB_SEARCH: base + '/search' } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async base => window.desktop.updateSettings({ connections: [{ id: 'search', provider: 'ollama', label: 'Search fixture', url: base }], mainModel: { provider: 'ollama', connectionId: 'search', model: 'search-model', contextLimit: 65536 }, plannerModel: null, subagentModel: null }), base);
    const send = async (message: string) => {
      await page.getByLabel('Message', { exact: true }).fill(message);
      await page.getByRole('button', { name: 'Send ↑' }).click();
    };
    await send('Search for the official report and verify its total.');
    await expect(page.locator('.chat-assistant')).toContainText('Verified total 721', { timeout: 30_000 });
    expect(searches).toBe(1); expect(reads).toBe(1);
    const browser = await page.evaluate(async () => {
      const snapshot = await window.desktop.snapshot();
      return window.desktop.previewChatBrowser(snapshot.chats[0].id);
    });
    expect(browser).toBeNull();
    await send('Recall the total from the saved source.');
    await expect(page.locator('.chat-assistant').last()).toContainText('The saved total is 721');
    expect(searches).toBe(1); expect(reads).toBe(1);
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await send('Delegate the report research to a Subagent.');
    await expect(page.locator('.chat-assistant')).toContainText('Subagent verified 721', { timeout: 30_000 });
    expect(subagents).toBe(1); expect(searches).toBe(2); expect(reads).toBe(2);
    expect(errors).toEqual([]);
    const evidence = await page.evaluate(async () => (await window.desktop.snapshot()).chats[0].messages.at(-1)?.sourceEvidence?.map(item => item.tool));
    expect(evidence).toEqual(['web_search', 'web_fetch', 'delegate_task']);
  } finally {
    await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(data, { recursive: true, force: true });
  }
});
