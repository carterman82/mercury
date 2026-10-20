import { test, expect, _electron as electron } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('runs four chats at once, queues overflow, and isolates Stop and background completion', async () => {
  test.setTimeout(90_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-concurrent-'));
  const waiting = new Map<string, ServerResponse>(); const received: string[] = [];
  const finish = (name: string) => { const response = waiting.get(name)!; waiting.delete(name); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `Completed ${name}` } }] })}\n\ndata: [DONE]\n\n`); };
  const server = createServer(async (request, response) => {
    if (request.url === '/api/v1/models') { response.end(JSON.stringify({ models: [{ type: 'llm', key: 'parallel-model', loaded_instances: [{ id: 'parallel-model', config: { parallel: 4 } }], capabilities: { trained_for_tool_use: true, vision: true } }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); const name = input.messages.at(-1).content;
    received.push(name); waiting.set(name, response);
    response.on('close', () => { if (waiting.get(name) === response) waiting.delete(name); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as { port: number }).port;
  const app = await electron.launch({ executablePath: path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async port => {
      await window.desktop.updateSettings({ connections: [{ id: 'parallel', provider: 'lmstudio', label: 'Parallel server', url: `http://127.0.0.1:${port}` }], defaultModel: { provider: 'lmstudio', connectionId: 'parallel', model: 'parallel-model', contextLimit: 8192 }, overrides: {} });
      await window.desktop.discover({ id: 'parallel', provider: 'lmstudio', label: 'Parallel server', url: `http://127.0.0.1:${port}` });
    }, port);
    const newChat = page.getByRole('button', { name: 'New chat', exact: false });
    for (let index = 1; index <= 6; index++) {
      await expect(newChat).toBeEnabled(); await newChat.click();
      await page.getByLabel('Message', { exact: true }).fill(`Parallel chat ${index}`);
      await page.getByRole('button', { name: 'Send ↑' }).click();
      await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
    }
    await expect.poll(() => received.length).toBe(4);
    let snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.activeChatIds).toHaveLength(6); expect(snapshot.modelRequests![0]).toMatchObject({ active: 4, queued: 2, limit: 4 });
    await expect(page.locator('.chat-assistant')).toContainText('Waiting for a free request slot');
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).activeChatIds!.length).toBe(5);
    expect(received).not.toContain('Parallel chat 6');
    // Stop an active chat; only it releases a slot, allowing the fifth to dispatch.
    await page.locator('.session-list').getByRole('button', { name: /Parallel chat 1/ }).click();
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect.poll(() => received.length).toBe(5); expect(received.at(-1)).toBe('Parallel chat 5');
    // Completing another chat must not steal focus from the currently selected one.
    finish('Parallel chat 2');
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chats.find(chat => chat.title === 'Parallel chat 2')!.status).toBe('idle');
    await expect(page.locator('.chat-user')).toContainText('Parallel chat 1');
    for (const name of ['Parallel chat 3', 'Parallel chat 4', 'Parallel chat 5']) finish(name);
    await expect.poll(async () => (await page.evaluate(() => window.desktop.snapshot())).activeChatIds!.length).toBe(0);
    snapshot = await page.evaluate(() => window.desktop.snapshot()); expect(snapshot.modelRequests).toEqual([]);
    expect(snapshot.chats.filter(chat => chat.status === 'stopped')).toHaveLength(2);
    expect(snapshot.chats.filter(chat => chat.status === 'idle')).toHaveLength(4);
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
