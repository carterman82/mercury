import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('recovers once from a thinking loop, then supports another message and Stop', async () => {
  test.setTimeout(45_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-thinking-e2e-'));
  const requests: any[] = [];
  let recovered = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'qwen-fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    const last = input.messages.at(-1).content;
    if (last === 'wait') { response.write(JSON.stringify({ message: { thinking: 'Working on a different problem.' }, done: false }) + '\n'); return; }
    if (!recovered) {
      recovered = true;
      const phrase = 'One final check: lit could mean list or lite. I will output this. Final answer: here is a concise list of the results. Do you have initial conditions?\n';
      response.write(JSON.stringify({ message: { thinking: phrase.repeat(20) }, done: false }) + '\n');
      // Leave the stream open. Mercury must abort it rather than await done.
      return;
    }
    response.end(JSON.stringify({ message: { content: 'Glad it helped!' }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(port => window.desktop.updateSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Thinking fixture', url: `http://127.0.0.1:${port}` }], mainModel: { provider: 'ollama', connectionId: 'fixture', model: 'qwen-fixture', contextLimit: 32768 }, plannerModel: null, subagentModel: null }), port);
    await page.getByLabel('Message', { exact: true }).fill('lit');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toContainText('Glad it helped!');
    await expect(page.locator('.chat-assistant .chat-notice')).toContainText('Repetitive thinking detected');
    expect(requests).toHaveLength(2);
    expect(requests[1].think).toBe(false);
    expect(requests[1].messages[0].content).toContain('Answer the latest user message directly now');
    await page.locator('.thinking-panel summary').click();
    await expect(page.locator('.thinking-body')).toContainText('One final check');
    await page.getByLabel('Message', { exact: true }).fill('wait');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(page.getByRole('button', { name: 'Send ↑' })).toBeVisible();
    const state = await page.evaluate(() => window.desktop.snapshot());
    expect(state.activeChatId).toBeNull();
    expect(state.chats[0].status).toBe('stopped');
    expect(requests).toHaveLength(3);
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
