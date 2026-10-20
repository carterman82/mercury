import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from '@napi-rs/canvas';

test('sends the actual image, restores it on follow-ups, and falls back to OCR for text-only models', async () => {
  test.setTimeout(120_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-vision-'));
  const canvas = createCanvas(800, 180); const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, 800, 180); context.fillStyle = '#000000'; context.font = '48px Arial'; context.fillText('VISION FALLBACK 2026', 30, 110);
  const png = canvas.toBuffer('image/png'); const filename = path.join(data, 'image.png'); writeFileSync(filename, png);
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'vision-model' }, { name: 'text-model' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (body.model === 'text-model' && body.messages.some((message: any) => message.images?.length)) {
      response.writeHead(400); response.end(JSON.stringify({ error: 'this model does not support images' })); return;
    }
    response.end(JSON.stringify({ message: { content: body.model === 'vision-model' ? 'Actual image received.' : 'Text fallback received.' }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    const configure = async (model: string) => page.evaluate(({ port, model }) => window.desktop.updateSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Vision fixture', url: `http://127.0.0.1:${port}` }], mainModel: { provider: 'ollama', connectionId: 'fixture', model, contextLimit: 32768 }, plannerModel: null, subagentModel: null }), { port, model });
    const upload = async () => {
      await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'vision-drop'; input.style.display = 'none'; document.body.appendChild(input); });
      await page.locator('#vision-drop').setInputFiles(filename);
      await page.evaluate(() => { const input = document.getElementById('vision-drop') as HTMLInputElement; const transfer = new DataTransfer(); transfer.items.add(input.files![0]); document.querySelector('.chat-layout')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); input.remove(); });
      await expect(page.locator('.pending-files')).toContainText('image.png', { timeout: 60_000 });
    };
    const send = async (text: string) => { await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send ↑' }).click(); };
    await configure('vision-model'); await upload(); await send('Describe this image.');
    await expect(page.locator('.chat-assistant')).toContainText('Actual image received.');
    expect(requests[0].messages.at(-1).images).toEqual([png.toString('base64')]);
    await send('What else is visible?');
    await expect(page.locator('.chat-assistant')).toHaveCount(2);
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator('.chat-assistant').last()).toContainText('Actual image received.');
    expect(requests[1].messages.some((message: any) => message.images?.[0] === png.toString('base64'))).toBe(true);
    // The persisted history contains descriptors, never image payloads.
    expect(JSON.stringify((await page.evaluate(() => window.desktop.snapshot())).chats)).not.toContain(png.toString('base64'));
    await configure('text-model'); await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await upload(); await send('Read the image text.');
    await expect(page.locator('.chat-assistant')).toContainText('Text fallback received.');
    await expect(page.locator('.chat-assistant')).toContainText('does not support image input');
    expect(requests).toHaveLength(4);
    expect(requests[2].messages.at(-1).images).toHaveLength(1);
    expect(requests[3].messages.at(-1).images).toBeUndefined();
    expect(requests[3].messages.at(-1).content).toContain('VISION FALLBACK 2026');
    await send('Repeat the image text.'); await expect(page.locator('.chat-assistant')).toHaveCount(2);
    await expect.poll(() => requests.length).toBe(5);
    await expect(page.locator('.chat-assistant').last()).toContainText('Text fallback received.');
    expect(requests[4].messages.every((message: any) => !message.images)).toBe(true);
    expect(JSON.stringify(requests[4])).toContain('VISION FALLBACK 2026');
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
