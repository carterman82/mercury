import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { ChatBrowser } from './chat-browser';
import { WebPolicy } from './web-policy';
import { ChatApprovals } from './chat-approvals';
import { createHash } from 'node:crypto';
let browser: ChatBrowser | undefined, server: Server | undefined;
afterEach(async () => { await browser?.dispose(); server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); });
it('tests an owned localhost question and exposes current script errors without allowing public forms', async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<body><textarea id="question"></textarea><input id="secret" type="password"><p id="reply"></p><script>question.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();reply.textContent='Answer to '+question.value}};${request.url === '/broken' ? "throw new Error('POSES is not defined')" : ''}</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const policy = new WebPolicy(base); policy.allowLocalOrigin('owner', base);
  let mode = 2;
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), policy, undefined, undefined, () => mode >= 2);
  const signal = new AbortController().signal;
  const broken = await browser.open('owner', base + '/broken', signal);
  expect(broken.errors).toContain('POSES is not defined');
  const opened = await browser.open('owner', base, signal); expect(opened.errors).toEqual([]);
  const answered = await browser.fill('owner', '#question', 'What is two plus two?', true, signal, '#reply');
  expect(answered.replyBefore).toBe('');
  expect(answered.submitted).toBe(true);
  expect((await browser.read('owner',0,signal,'#reply')).selected?.text).toContain('Answer to');
  expect(answered.content).toContain('Answer to What is two plus two?');
  await expect(browser.fill('owner', '#secret', 'secret', false, signal)).rejects.toThrow('prohibited');
  await browser.open('other', base, signal);
  await expect(browser.fill('other', '#question', 'no', false, signal)).rejects.toThrow('owned localhost');
  mode = 1;
  await expect(browser.fill('owner', '#question', 'no', false, signal)).rejects.toThrow('permission level');
});
it('clicks owned visible buttons by selector and rejects public, hidden, disabled and non-button controls', async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<button id="load" onclick="document.getElementById(\'state\').textContent=\'Clicked\'">Load</button><button id="hidden" hidden>Hidden</button><button id="disabled" disabled>Disabled</button><input id="password" type="password"><p id="state">Waiting</p>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const policy = new WebPolicy(base); policy.allowLocalOrigin('owner', base);
  let mode = 2;
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), policy, undefined, undefined, () => mode >= 2);
  const signal = new AbortController().signal;
  await browser.open('owner', base, signal);
  expect((await browser.clickButton('owner', '#load', signal)).content).toContain('Clicked');
  for (const selector of ['#hidden', '#disabled']) await expect(browser.clickButton('owner', selector, signal)).rejects.toThrow('visible enabled');
  await expect(browser.clickButton('owner', '#password', signal)).rejects.toThrow('ordinary buttons');
  await expect(browser.clickButton('owner', 'iframe >> button', signal)).rejects.toThrow('bounded');
  await browser.open('other', base, signal);
  await expect(browser.clickButton('other', '#load', signal)).rejects.toThrow('owned localhost');
  mode = 1;
  await expect(browser.clickButton('owner', '#load', signal)).rejects.toThrow('permission level');
}, 15000);

it.skipIf(!process.env.MERCURY_BROWSER_TEST_CHANNEL)('uses an explicit full-browser channel for hardware WebGPU while retaining network restrictions', async () => {
  const channel = process.env.MERCURY_BROWSER_TEST_CHANNEL;
  if (channel !== 'chromium' && channel !== 'chrome' && channel !== 'msedge') throw new Error('Unsupported test browser channel');
  let posts = 0;
  server = createServer((request, response) => {
    if (request.method === 'POST') posts++;
    response.setHeader('content-type', 'text/html');
    response.end('<p id="gpu">Checking</p><script>navigator.gpu.requestAdapter().then(adapter=>document.getElementById("gpu").textContent=adapter?"GPU adapter ready":"No adapter");fetch("/blocked",{method:"POST"}).catch(()=>{});</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), new WebPolicy(base), undefined, undefined, () => true, channel);
  const signal = new AbortController().signal;
  await browser.open('gpu', base, signal);
  await expect.poll(async () => (await browser!.read('gpu', 0, signal)).content).toContain('GPU adapter ready');
  expect(posts).toBe(0);
});

it.each([2, 3])('automatically allows project browser controls at permission level %s and restores approval on downgrade', async initialMode => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<body style="margin:0"><button style="width:200px;height:100px" onclick="this.textContent=\'Clicked\'">Start</button><p id="keys">Keys: 0</p><script>let count=0;document.onkeydown=()=>document.getElementById("keys").textContent="Keys: "+(++count)</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const approvals = new ChatApprovals(() => {});
  const request = vi.spyOn(approvals, 'request');
  let mode = initialMode;
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), new WebPolicy(base), approvals, undefined, id => id === 'project' && mode >= 2);
  const signal = new AbortController().signal;
  await browser.open('project', base, signal);
  expect((await browser.pointer('project', 50, 50, signal)).content).toContain('Clicked');
  expect((await browser.press('project', ['ArrowRight'], signal)).content).toContain('Keys: 1');
  await browser.enableControls('project', signal);
  expect(request).not.toHaveBeenCalled(); expect(approvals.snapshot()).toEqual([]);
  mode = 1;
  await expect(browser.pointer('project', 50, 50, signal)).rejects.toThrow('browser_enable_controls');
  const permission = browser.enableControls('project', signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  approvals.answer(approvals.snapshot()[0].id, true); await permission;
  await expect(browser.pointer('project', 50, 50, signal)).resolves.toBeDefined();
  mode = 3;
  await browser.open('ordinary', base, signal);
  await expect(browser.pointer('ordinary', 50, 50, signal)).rejects.toThrow('browser_enable_controls');
});
it('previews owned local websites with WebSockets and refuses other chats', async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<body><p id="state">waiting</p><script>new WebSocket(location.origin.replace("http:","ws:")).onopen=()=>{document.getElementById("state").textContent="Local hot reload connected"}</script>');
  });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.on('error', () => {}); socket.on('end', () => socket.end());
    socket.on('data', () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.on('close', () => clearTimeout(timer));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const policy = new WebPolicy(); policy.allowLocalOrigin('owner', base);
  browser = new ChatBrowser(path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '.build-resources/browser-runtime'), policy);
  const signal = new AbortController().signal;
  await expect(browser.open('other', base, signal)).rejects.toThrow();
  await browser.open('owner', base, signal);
  await expect.poll(async () => (await browser!.read('owner', 0, signal)).content).toContain('Local hot reload connected');
  policy.revokeLocalOrigin('owner', base);
  await expect(browser.read('owner', 0, signal)).rejects.toThrow();
});
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
