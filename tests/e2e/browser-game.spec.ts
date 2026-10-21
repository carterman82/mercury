import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('passes real game screenshots to the model and controls an iframe only after approval', async () => {
  test.setTimeout(90_000); const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-game-')); let base = '', observedMoves = false, pictures = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'game-model' }] })); return; }
    if (request.url === '/api/show') { response.end('{}'); return; }
    if (request.url === '/page') { response.end('<body style="margin:0"><iframe src="/game" style="border:0;width:800px;height:500px"></iframe>'); return; }
    if (request.url === '/game') { response.end('<body style="margin:0"><canvas id="game" tabindex="0" width="600" height="300" onclick="this.focus()"></canvas><p id="moves">Moves: 0</p><script>let n=0;game.onkeydown=e=>{moves.textContent="Moves: "+(++n);const ctx=game.getContext("2d");ctx.fillStyle="red";ctx.fillRect(n*20,20,50,50)};</script>'); return; }
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw);
    const results = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    const actions = ['browser_open', 'browser_screenshot', 'browser_enable_controls', 'browser_pointer', 'browser_press', 'browser_screenshot'];
    const args = [{ url: base + '/page' }, {}, {}, { x: 50, y: 50 }, { keys: ['ArrowRight', 'ArrowLeft'] }, {}];
    if (results.at(-1)?.file?.name === 'Browser-screenshot.jpg') {
      const images = input.messages.filter((message: any) => message.role === 'user' && message.images?.length);
      expect(images.at(-1).images[0]).toMatch(/^\/9j\//); expect(images.at(-1).browserCapture).toBeUndefined(); pictures++;
    }
    if (results.length === 5) observedMoves = JSON.stringify(results.at(-1).frames).includes('Moves: 2');
    const error = results.find((result: any) => result.error)?.error;
    response.end(JSON.stringify({ message: { content: error ? 'Error: ' + error : results.length === 6 ? 'Observed two game moves from the embedded frame.' : '', ...(!error && results.length < 6 ? { tool_calls: [{ function: { name: actions[results.length], arguments: args[results.length] } }] } : {}) }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as any).port}`;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data, MERCURY_TEST_NETWORK_ORIGIN: base } });
  try {
    const page = await app.firstWindow(); await page.evaluate(base => window.desktop.updateSettings({ connections: [{ id: 'game', provider: 'ollama', label: 'Game fixture', url: base }], mainModel: { provider: 'ollama', connectionId: 'game', model: 'game-model', contextLimit: 65536 }, plannerModel: null, subagentModel: null }), base);
    await page.getByLabel('Message', { exact: true }).fill('Play the embedded game.'); await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.getByRole('region', { name: 'Plugin approval' })).toContainText('Allow game controls', { timeout: 30_000 });
    const panel = page.getByRole('complementary', { name: 'Context panel' });
    await expect(panel.getByRole('tab', { name: 'Browser', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('img', { name: 'Live AI browser viewport', exact: true })).toBeVisible();
    const initialViewport = await panel.getByRole('img', { name: 'Live AI browser viewport', exact: true }).getAttribute('src');
    await expect(panel.locator('.context-address')).toHaveText(base + '/page');
    await panel.getByRole('button', { name: 'Shrink context panel', exact: true }).click();
    await expect(panel.getByRole('tabpanel')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Show AI browser', exact: true }).click();
    await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await expect(page.locator('.chat-assistant')).toContainText('Observed two game moves');
    await expect.poll(() => panel.getByRole('img', { name: 'Live AI browser viewport', exact: true }).getAttribute('src')).not.toBe(initialViewport);
    expect(observedMoves).toBe(true); expect(pictures).toBe(2);
    const state = await page.evaluate(() => window.desktop.snapshot()); const files = state.chats[0].messages.at(-1)!.files!;
    expect(files).toHaveLength(2); for (const file of files) expect(readFileSync(path.join(data, 'chat-files', file.id + '.bin')).subarray(0, 2).toString('hex')).toBe('ffd8');
    await page.screenshot({ path: 'test-results/mercury-game-controls.png' });
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});

test('live Bloxorz page is accessible and its iframe/canvas can be inspected', async () => {
  test.skip(!process.env.MERCURY_LIVE_GAME, 'Opt-in live game inspection, not a completion claim.'); test.setTimeout(90_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-live-game-')); let pageRead: any, picture = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'game-model' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw); const results = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    if (results.length === 1) pageRead = results[0];
    if (results.length === 3) picture = input.messages.some((message: any) => message.images?.length);
    const sequence = ['browser_open', 'browser_wait', 'browser_screenshot']; const args = [{ url: 'https://bagelcomics.com/games/html/bloxorz.html' }, { milliseconds: 3000 }, {}];
    response.end(JSON.stringify({ message: { content: results.length === 3 ? 'Live game page and screenshot inspected.' : '', ...(results.length < 3 ? { tool_calls: [{ function: { name: sequence[results.length], arguments: args[results.length] } }] } : {}) }, done: true }) + '\n');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow(); await page.evaluate(base => window.desktop.updateSettings({ connections: [{ id: 'live', provider: 'ollama', label: 'Live game fixture', url: base }], mainModel: { provider: 'ollama', connectionId: 'live', model: 'game-model', contextLimit: 65536 }, plannerModel: null, subagentModel: null }), base);
    await page.getByLabel('Message', { exact: true }).fill('Inspect Bloxorz.'); await page.getByRole('button', { name: 'Send ↑' }).click(); await expect(page.locator('.chat-assistant')).toContainText('Live game page', { timeout: 60_000 });
    console.log('Live Bloxorz page:', JSON.stringify({ title: pageRead?.title, content: pageRead?.content?.slice(0, 1000), frames: pageRead?.frames, error: pageRead?.error }));
    const file = (await page.evaluate(() => window.desktop.snapshot())).chats[0].messages.at(-1)?.files?.[0]; if (file) copyFileSync(path.join(data, 'chat-files', file.id + '.bin'), 'test-results/mercury-live-game-viewport.jpg');
    expect(pageRead?.error).toBeUndefined(); expect(pageRead.url).toContain('bagelcomics.com'); expect(pageRead.embeds.some((embed: any) => /ruffle|embed|object/i.test(embed.tag))).toBe(true); expect(picture).toBe(true);
    console.log('Live Bloxorz frames:', JSON.stringify(pageRead.frames.map((frame: any) => ({ url: frame.url, title: frame.title, canvases: frame.canvases }))));
    await page.screenshot({ path: 'test-results/mercury-live-bloxorz.png' });
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
