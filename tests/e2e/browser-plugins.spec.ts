import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

for (const npm of [false, true]) test(npm ? 'installs and invokes the real pinned npm memory MCP server in the packaged app' : 'browses with bundled Chromium and discovers, denies, installs, invokes, and restores a remote plugin', async () => {
  test.skip(npm && !process.env.MERCURY_LIVE_NPM, 'Opt-in real npm download/installation test.');
  test.setTimeout(240_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-browser-plugins-'));
  let base = '', rpcCalls = 0, initializations = 0;
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'tools-model' }] })); return; }
    if (request.url === '/page') { response.setHeader('content-type', 'text/html'); response.end('<title>Fixture home</title><body><p id="rendered">Loading</p><a href="/article">Read article</a><script>document.getElementById("rendered").textContent="Browser JavaScript works";</script></body>'); return; }
    if (request.url === '/article') { response.end('<title>Source article</title><body>Verified source fact: Mercury browser test 2026.</body>'); return; }
    if (request.url?.startsWith('/registry')) {
      const server = npm ? { name: 'test/official-memory', version: '2.0.0', description: 'Pinned official MCP memory package, isolated test only.', packages: [{ registryType: 'npm', identifier: '@modelcontextprotocol/server-memory', version: '2.0.0', transport: { type: 'stdio' } }] } : { name: 'test/fixture-calculator', version: '1.0.0', description: 'Fixture addition service.', remotes: [{ type: 'streamable-http', url: base + '/mcp' }] };
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ servers: [{ server }] })); return;
    }
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (request.url === '/mcp') {
      if (input.method.startsWith('notifications/')) { response.writeHead(202); response.end(); return; }
      let result: unknown;
      if (input.method === 'initialize') { initializations++; result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; }
      if (input.method === 'tools/list') result = { tools: [{ name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] };
      if (input.method === 'tools/call') { rpcCalls++; result = { content: [{ type: 'text', text: String(input.params.arguments.a + input.params.arguments.b) }] }; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result })); return;
    }
    const tools = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    for (const tool of tools) if (tool.error && !tool.error.includes('denied')) errors.push(tool.error);
    const user = input.messages.find((message: any) => message.role === 'user')?.content ?? '';
    const calls: any[] = []; let text = '';
    const call = (name: string, args: unknown) => calls.push({ function: { name, arguments: args } });
    if (user.startsWith('Browse')) {
      if (!tools.length) call('browser_open', { url: base + '/page' });
      else if (tools.length === 1) { if (!tools[0].content?.includes('Browser JavaScript works')) errors.push('JavaScript not rendered'); call('browser_click', { url: base + '/article' }); }
      else text = `Verified source fact: Mercury browser test 2026. [Source article](${base}/article)`;
    } else if (tools.at(-1)?.error?.includes('denied')) text = 'Denied safely. No plugin executed.';
    else if (!tools.length) call('discover_plugins', { query: 'fixture' });
    else if (tools.length === 1) {
      if (user.startsWith('Reuse')) call('plugin_call_tool', { pluginId: tools[0].installed[0].id, tool: 'add', arguments: { a: 3, b: 4 } });
      else call('install_plugin', { candidateId: tools[0].matches[0].candidateId });
    } else if (tools.length === 2 && !user.startsWith('Reuse')) {
      if (npm && !tools[1].tools?.some((tool: any) => tool.name === 'create_entities')) errors.push('Real memory tools missing');
      call('plugin_call_tool', { pluginId: tools[1].pluginId, tool: npm ? 'create_entities' : 'add', arguments: npm ? { entities: [{ name: 'Mercury isolated runtime test', entityType: 'test', observations: ['Real npm MCP package ran successfully.'] }] } : { a: 3, b: 4 } });
    } else {
      if (tools.at(-1)?.isError) errors.push('MCP tool returned an error result');
      if (npm && !JSON.stringify(tools.at(-1)).includes('Mercury isolated runtime test')) errors.push('Created memory entity missing from real tool result');
      text = npm ? 'Real npm memory plugin completed.' : 'Plugin result: ' + tools.at(-1)?.content?.[0]?.text;
    }
    response.end(JSON.stringify({ message: { content: text, ...(calls.length ? { tool_calls: calls } : {}) }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const launch = () => electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data, MERCURY_TEST_NETWORK_ORIGIN: base, MERCURY_TEST_PLUGIN_REGISTRY: base + '/registry' } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(async base => window.desktop.updateSettings({ connections: [{ id: 'tools', provider: 'ollama', label: 'Tools model', url: base }], defaultModel: { provider: 'ollama', connectionId: 'tools', model: 'tools-model', contextLimit: 65536 }, overrides: {} }), base);
    const send = async (text: string) => { await page.getByRole('button', { name: 'New chat', exact: false }).click(); await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send ↑' }).click(); };
    const approve = async () => { await expect(page.getByRole('region', { name: 'Plugin approval' })).toBeVisible({ timeout: 150_000 }); await page.getByRole('button', { name: 'Allow once', exact: true }).click(); };
    if (!npm) {
      await send('Browse the fixture website.'); await expect(page.locator('.chat-assistant')).toContainText('Verified source fact');
      await expect(page.locator('.chat-assistant a')).toHaveAttribute('href', base + '/article');
      await send('Find a fixture plugin but let me deny it.'); await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
      expect(initializations).toBe(0); await page.getByRole('button', { name: 'Deny', exact: true }).click(); await expect(page.locator('.chat-assistant')).toContainText('Denied safely'); expect(initializations).toBe(0);
    }
    await send('Install the fixture plugin and run its tool.'); await approve();
    await expect(page.getByRole('region', { name: 'Plugin approval' })).toContainText(npm ? 'create_entities' : 'add', { timeout: 150_000 });
    if (!npm) expect(rpcCalls).toBe(0);
    await approve(); await expect(page.locator('.chat-assistant')).toContainText(npm ? 'Real npm memory plugin completed.' : 'Plugin result: 7', { timeout: 60_000 });
    if (npm) expect(readdirSync(path.join(data, 'plugins')).length).toBeGreaterThan(0);
    else {
      expect(rpcCalls).toBe(1); await app.close(); app = await launch(); page = await app.firstWindow();
      await send('Reuse the installed plugin.'); await expect(page.getByRole('region', { name: 'Plugin approval' })).toBeVisible();
      await page.getByRole('button', { name: 'Stop response', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Plugin approval' })).toHaveCount(0); expect(rpcCalls).toBe(1);
      await send('Reuse the installed plugin again.'); await approve(); await expect(page.locator('.chat-assistant')).toContainText('Plugin result: 7'); expect(rpcCalls).toBe(2);
      await page.screenshot({ path: 'test-results/mercury-browser-plugins.png' });
    }
    expect(errors).toEqual([]);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).activeChatIds!.length).toBe(0);
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
