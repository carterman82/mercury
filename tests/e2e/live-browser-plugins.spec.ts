import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('live internet search, rendered source page, official registry, and real remote MCP invocation', async () => {
  test.skip(!process.env.MERCURY_LIVE_WEB, 'Opt-in public internet integration.'); test.setTimeout(240_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-live-web-'));
  const errors: string[] = []; let searched = false, read = false, called = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'web-model' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw);
    const user = input.messages.find((message: any) => message.role === 'user')?.content ?? '';
    const results = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    for (const result of results) if (result.error) errors.push(result.error);
    const calls: any[] = []; let text = '';
    const call = (name: string, args: unknown) => calls.push({ function: { name, arguments: args } });
    if (user.startsWith('Browse')) {
      if (!results.length) call('browser_search', { query: 'Playwright browser automation official documentation' });
      else if (results.length === 1) { searched = Boolean(results[0].links?.length); call('browser_open', { url: 'https://playwright.dev/docs/intro' }); }
      else { read = results[1].content?.includes('Playwright') && results[1].url === 'https://playwright.dev/docs/intro'; text = 'Live browser search and source-page reading succeeded.'; }
    } else if (!results.length) call('discover_plugins', { query: 'cloudflare' });
    else if (results.length === 1) {
      const candidate = results[0].matches?.find((match: any) => match.plan?.url === 'https://docs.mcp.cloudflare.com/mcp');
      if (!candidate) { errors.push('Cloudflare documentation candidate not returned'); text = 'Plugin discovery failed.'; }
      else call('install_plugin', { candidateId: candidate.candidateId });
    } else if (results.length === 2) {
      const tool = results[1].tools?.find((tool: any) => /search/i.test(tool.name) && tool.inputSchema?.properties?.query);
      if (!tool) { errors.push('Documentation search tool not returned'); text = 'MCP tool discovery failed.'; }
      else call('plugin_call_tool', { pluginId: results[1].pluginId, tool: tool.name, arguments: { query: 'Cloudflare Workers runtime documentation' } });
    } else { const last = results.at(-1); if (last?.isError) errors.push('Remote MCP returned an error result'); called = !last?.isError && last?.content?.some((block: any) => block.type === 'text' && block.text.length > 30); text = 'Live registry installation and remote MCP tool call succeeded.'; }
    response.end(JSON.stringify({ message: { content: text, ...(calls.length ? { tool_calls: calls } : {}) }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async base => window.desktop.updateSettings({ connections: [{ id: 'live-web', provider: 'ollama', label: 'Web tools fixture', url: base }], mainModel: { provider: 'ollama', connectionId: 'live-web', model: 'web-model', contextLimit: 65536 }, plannerModel: null, subagentModel: null }), base);
    const send = async (text: string) => { await page.getByRole('button', { name: 'New chat', exact: false }).click(); await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send ↑' }).click(); };
    await send('Browse the live Playwright documentation.'); await expect(page.locator('.chat-assistant')).toContainText('source-page reading succeeded', { timeout: 120_000 });
    expect(errors).toEqual([]); expect(searched).toBe(true); expect(read).toBe(true);
    await send('Find and use the Cloudflare documentation MCP plugin.');
    await expect(page.getByRole('region', { name: 'Plugin approval' })).toContainText('docs.mcp.cloudflare.com', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Plugin approval' })).toContainText('Cloudflare Workers runtime documentation', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.locator('.chat-assistant')).toContainText('remote MCP tool call succeeded', { timeout: 60_000 });
    expect(errors).toEqual([]); expect(called).toBe(true);
    await page.screenshot({ path: 'test-results/mercury-live-browser-plugins.png' });
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});

test('live local model actually chooses the browser tool and answers from the page', async () => {
  test.skip(!process.env.MERCURY_LIVE_MODEL || !process.env.MERCURY_LIVE_URL || !process.env.MERCURY_LIVE_WEB, 'Opt-in real model tool selection.'); test.setTimeout(180_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-live-model-web-'));
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async ({ url, model }) => window.desktop.updateSettings({ connections: [{ id: 'live', provider: 'lmstudio', label: 'Live local model', url }], mainModel: { provider: 'lmstudio', connectionId: 'live', model, contextLimit: 32768 }, plannerModel: null, subagentModel: null }), { url: process.env.MERCURY_LIVE_URL!, model: process.env.MERCURY_LIVE_MODEL! });
    await page.getByLabel('Message', { exact: true }).fill('Use browser_open to visit https://example.com/ now. Tell me the page title and one sentence about what it says, and cite that URL. Keep it brief.');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chats[0]?.status, { timeout: 150_000 }).toBe('idle');
    const answer = await page.locator('.chat-assistant .chat-message-content').innerText();
    const state = await page.evaluate(() => window.desktop.snapshot());
    expect(state.chats[0].messages.at(-1)?.toolActivity).toContainEqual(expect.objectContaining({ name: 'browser_open', status: 'succeeded' }));
    expect(answer).toContain('Example Domain'); await expect(page.locator('.chat-assistant a[href="https://example.com/"]')).toHaveCount(1);
    console.log('Live local model browsing:', answer);
    await page.getByLabel('Message', { exact: true }).fill('Now use discover_plugins to search the public MCP registry for cloudflare documentation plugins. Do not install or run any plugin. Briefly report a relevant result.');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect.poll(async () => {
      const chat = (await page.evaluate(() => window.desktop.snapshot())).chats[0];
      return chat?.messages.length >= 4 ? chat.status : 'waiting';
    }, { timeout: 120_000 }).toBe('idle');
    const found = (await page.evaluate(() => window.desktop.snapshot())).chats[0].messages.at(-1)!;
    expect(found.toolActivity).toContainEqual(expect.objectContaining({ name: 'discover_plugins', status: 'succeeded' }));
    expect(found.toolActivity?.some(action => action.name === 'install_plugin')).toBe(false);
    expect(found.content).toMatch(/cloudflare/i);
    await expect(page.getByRole('region', { name: 'Plugin approval' })).toHaveCount(0);
    console.log('Live local model plugin discovery:', found.content.slice(0, 1200));
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});
