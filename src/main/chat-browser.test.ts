import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { ChatBrowser } from './chat-browser';
import { WebPolicy } from './web-policy';
import { ChatApprovals } from './chat-approvals';
let browser: ChatBrowser | undefined, server: Server | undefined;
afterEach(async () => { await browser?.dispose(); server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); });
it('renders JS, follows links, pages text, isolates cookies, blocks POST/private redirects, and cancels navigation', async () => {
  let posts = 0, port = 0;
  server = createServer((request, response) => {
    if (request.method === 'POST') { posts++; response.end('bad'); return; }
    if (request.url === '/slow') return;
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/secret' }); response.end(); return; }
    response.setHeader('content-type', 'text/html');
    if (request.url === '/next') { response.end('<title>Next</title><body>Second page</body>'); return; }
    if (request.url === '/cookie') { response.end(`<body>Cookie: ${request.headers.cookie ?? 'NONE'}</body>`); return; }
    response.end(`<title>Browser fixture</title><body><p id="status">initial</p><a href="/next">Follow next</a><p>${'Long page content. '.repeat(1500)}</p><script>document.getElementById('status').textContent='Rendered by JavaScript';document.cookie='isolated=one';fetch('/write',{method:'POST'}).catch(()=>{});</script></body>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), new WebPolicy(base));
  const signal = new AbortController().signal;
  expect(await browser.preview('absent')).toBeNull();
  const first = await browser.open('one', base, signal); expect(first.content).toContain('Rendered by JavaScript'); expect(first.nextOffset).toBe(14000); expect(posts).toBe(0);
  const preview = await browser.preview('one'); expect(preview?.url).toBe(base + '/'); expect(preview?.image).toMatch(/^data:image\/jpeg;base64,\/9j\//);
  expect(await browser.preview('absent')).toBeNull();
  expect((await browser.read('one', 14000, signal)).content).toContain('Long page content');
  await expect(browser.click('one', base + '/invented', signal)).rejects.toThrow('exact link');
  expect((await browser.click('one', base + '/next', signal)).content).toContain('Second page');
  browser.release('one'); expect((await browser.read('one', 0, signal)).title).toBe('Next');
  expect((await browser.open('one', base + '/cookie', signal)).content).toContain('isolated=one');
  expect((await browser.open('two', base + '/cookie', signal)).content).toContain('NONE');
  await expect(browser.open('one', base + '/redirect', signal)).rejects.toThrow();
  const controller = new AbortController(); const pending = browser.open('three', base + '/slow', controller.signal); const check = expect(pending).rejects.toThrow();
  await new Promise(resolve => setTimeout(resolve, 100)); controller.abort(new Error('Stopped')); await check;
  await browser.close('one'); await expect(browser.read('one', 0, signal)).rejects.toThrow('Open a website');
}, 60_000);

it('continues a slowly progressing page and preserves a partially loaded page after real inactivity', async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html'); response.write('<html><body><p>Partial content</p>' + ' '.repeat(2048));
    if (request.url === '/stalled') return;
    let part = 0; const timer = setInterval(() => { response.write(`<p>Segment ${++part}</p>` + ' '.repeat(2048)); if (part === 6) { clearInterval(timer); response.end('</body></html>'); } }, 150);
    response.on('close', () => clearInterval(timer));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), new WebPolicy(base), undefined, 500);
  const page = await browser.open('progress', base + '/progress', new AbortController().signal); expect(page.content).toContain('Segment 6'); expect(page.loadWarning).toBeUndefined();
  const partial = await browser.open('partial', base + '/stalled', new AbortController().signal); expect(partial.content).toContain('Partial content'); expect(partial.loadWarning).toContain('stopped making progress');
}, 30_000);

it('observes iframe canvases and requires approval before focusing or pressing game keys', async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/game' ? '<body style="margin:0"><canvas id="game" width="600" height="300" tabindex="0" onclick="this.focus()"></canvas><p id="count">Moves: 0</p><script>let moves=0;game.onkeydown=e=>{count.textContent="Moves: "+(++moves);const c=game.getContext("2d");c.fillStyle="red";c.fillRect(moves*10,20,30,30)};</script>' : '<body style="margin:0"><iframe src="/game" style="border:0;width:800px;height:500px"></iframe>');
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const approvals = new ChatApprovals(() => {});
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), new WebPolicy(base), approvals);
  const signal = new AbortController().signal; const page = await browser.open('game', base, signal);
  await expect.poll(async () => (await browser!.read('game', 0, signal)).frames.some(frame => frame.url === base + '/game')).toBe(true);
  const before = await browser.screenshot('game', signal); expect(before._browserImage.mimeType).toBe('image/jpeg');
  await expect(browser.press('game', ['ArrowRight'], signal)).rejects.toThrow('enable_controls');
  const permission = browser.enableControls('game', signal);
  for (let wait = 0; wait < 100 && !approvals.snapshot().length; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  approvals.answer(approvals.snapshot()[0].id, true); await permission;
  await browser.pointer('game', 50, 50, signal); const moved = await browser.press('game', ['ArrowRight', 'ArrowLeft'], signal);
  expect(JSON.stringify(moved.frames)).toContain('Moves: 2'); expect((await browser.screenshot('game', signal))._browserImage.data).not.toBe(before._browserImage.data);
  await expect(browser.press('game', ['Control+L'], signal)).rejects.toThrow('game-key');
  const controller = new AbortController(); const playing = browser.press('game', Array(100).fill('ArrowRight'), controller.signal, 1000); const stopped = expect(playing).rejects.toThrow('Stopped');
  await new Promise(resolve => setTimeout(resolve, 80)); controller.abort(new Error('Stopped')); await stopped;
  await browser.close('game'); await browser.open('game', base, signal); await expect(browser.press('game', ['ArrowRight'], signal)).rejects.toThrow('enable_controls');
}, 30_000);
