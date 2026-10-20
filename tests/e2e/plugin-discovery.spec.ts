import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

for (const live of [false, true]) test(live ? 'discovers website integrations from the real public registry without installing' : 'expands an empty website-category search and reports ready and setup-required plugins without installing', async () => {
  test.skip(live && !process.env.MERCURY_LIVE_WEB, 'Opt-in real registry discovery.'); test.setTimeout(180_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-discovery-e2e-'));
  const queries: string[] = []; let discovery: any;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'discovery-model' }] })); return; }
    if (request.url?.startsWith('/registry')) {
      const query = new URL(request.url, 'http://fixture.invalid').searchParams.get('search')!; queries.push(query);
      const name = query === 'context7' ? 'docs/context7' : query === 'vercel' ? 'deploy/vercel' : null;
      response.end(JSON.stringify({ servers: name ? [{ server: { name, description: 'Website integration', version: '1.0.0', packages: [{ registryType: query === 'vercel' ? 'pypi' : 'npm', identifier: '@fixture/plugin', version: '1.0.0', transport: { type: 'stdio' } }] } }] : [] })); return;
    }
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), last = input.messages.at(-1);
    if (last.role === 'tool') {
      discovery = JSON.parse(last.content);
      response.end(JSON.stringify({ message: { content: 'Discovery checked: ' + discovery.matches?.map((match: any) => match.name).join(', ') }, done: true }) + '\n');
    } else response.end(JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'discover_plugins', arguments: { query: 'web dev, deployment, or UI frameworks' } } }] }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data, ...(!live ? { MERCURY_TEST_NETWORK_ORIGIN: base, MERCURY_TEST_PLUGIN_REGISTRY: base + '/registry' } : {}) } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(base => window.desktop.updateSettings({ connections: [{ id: 'discovery', provider: 'ollama', label: 'Discovery fixture', url: base }], mainModel: { provider: 'ollama', connectionId: 'discovery', model: 'discovery-model', contextLimit: 65536 }, plannerModel: null, subagentModel: null }), base);
    await page.getByLabel('Message', { exact: true }).fill('Find plugins for website development, deployment, and UI frameworks. Do not install anything.');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toContainText('Discovery checked:', { timeout: 120_000 });
    if (live) expect(['found', 'partial']).toContain(discovery.status);
    else expect(discovery.status).toBe('found');
    expect(discovery.matches.length).toBeGreaterThan(0);
    expect(discovery.searches.map((search: any) => search.query)).toEqual(expect.arrayContaining(['context7', 'shadcn', 'vercel']));
    expect(discovery.matches.some((match: any) => /context7|shadcn|vercel|cloudflare|react|netlify|nextjs|figma/i.test(match.name))).toBe(true);
    if (!live) { expect(queries).toContain('context7'); expect(discovery.matches.some((match: any) => match.installable === false)).toBe(true); }
    const state = await page.evaluate(() => window.desktop.snapshot());
    expect(state.chatApprovals).toEqual([]);
    expect(state.chats[0].messages.at(-1)?.toolActivity).toEqual([expect.objectContaining({ name: 'discover_plugins', status: 'succeeded' })]);
    console.log(live ? 'Live discovery:' : 'Fixture discovery:', JSON.stringify({ status: discovery.status, names: discovery.matches.map((match: any) => match.name), searches: discovery.searches.length }));
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
