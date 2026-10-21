import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('eight uploaded files call Gemma automatically and show delegation in the packaged app', async () => {
  test.setTimeout(90_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-delegation-e2e-'));
  const sources = Array.from({ length: 8 }, (_, index) => {
    const filename = path.join(data, `source-${index}.txt`);
    writeFileSync(filename, `Raw source evidence ${index}`);
    return filename;
  });
  const requests: any[] = [];
  let releaseWorkers!: () => void;
  const workerGate = new Promise<void>(resolve => { releaseWorkers = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'main-fixture' }, { name: 'gemma-fixture' }] })); return; }
    if (request.url !== '/api/chat') { response.end('{}'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    if (input.model === 'gemma-fixture') await workerGate;
    const source = JSON.stringify(input.messages).match(/source-(\d)\.txt/)?.[1];
    const content = input.model === 'gemma-fixture' ? `Verified finding from source ${source}` : 'Combined answer from eight Subagent findings.';
    response.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
    const page = await app.firstWindow();
    await page.evaluate(async port => window.desktop.updateSettings({
      connections: [{ id: 'fixture', provider: 'ollama', label: 'Delegation fixture', url: `http://127.0.0.1:${port}`, maxConcurrentRequests: 3 }],
      mainModel: { provider: 'ollama', connectionId: 'fixture', model: 'main-fixture', contextLimit: 32768 },
      plannerModel: null,
      subagentModel: { provider: 'ollama', connectionId: 'fixture', model: 'gemma-fixture', contextLimit: 8192 },
    }), port);
    await page.getByLabel('Choose chat files', { exact: true }).setInputFiles(sources);
    await expect(page.locator('.pending-files')).toContainText('source-7.txt');
    await page.getByLabel('Message', { exact: true }).fill('Compare these eight files');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.getByLabel('Subagent activity', { exact: true }).getByRole('status').first()).toHaveText('Working · Subagent · gemma-fixture · source-0.txt');
    releaseWorkers();
    await expect(page.locator('.chat-assistant')).toContainText('Combined answer from eight Subagent findings.');
    await expect(page.locator('.chat-assistant .chat-notice')).toContainText('Using Subagents (gemma-fixture)');
    await expect(page.locator('.chat-assistant .chat-notice')).toContainText('8/8 finished');
    expect(requests.map(input => input.model)).toEqual([...Array(8).fill('gemma-fixture'), 'main-fixture']);
    expect(requests.slice(0, 8).every(input => input.tools.length === 1 && input.tools[0].function.name === 'read_file')).toBe(true);
    const mainInput = JSON.stringify(requests.at(-1).messages);
    for (let index = 0; index < 8; index++) expect(mainInput).toContain(`Verified finding from source ${index}`);
    expect(mainInput).not.toContain('Raw source evidence');
    const activity = page.getByLabel('Subagent activity', { exact: true });
    await expect(activity.getByRole('status')).toHaveCount(8);
    await expect(activity.getByRole('status').last()).toBeVisible();
    await expect(activity.getByRole('status').last()).toHaveText('Done · Subagent · gemma-fixture · source-7.txt');
    await expect(activity.getByText('Verified finding from source 7', { exact: true })).not.toBeVisible();
    await activity.locator('details').last().locator('summary').click();
    await expect(activity.getByText('Verified finding from source 7', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/automatic-delegation.png' });
  } finally {
    releaseWorkers();
    await app?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(data, { recursive: true, force: true });
  }
});
