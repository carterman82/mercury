import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('plans through /plan, implements the reviewed proposal, and persists checklist checkoffs', async () => {
  test.setTimeout(90000);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-plan-ui-'));
  const requests: any[] = [];
  const proposal = '# Export workflow\n\n- Inspect the current flow\n- Implement presets\n- Verify exports';
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags' || request.url === '/api/ps') { response.end(JSON.stringify({ models: [{ name: 'plan-fixture' }] })); return; }
    if (request.url !== '/api/chat') { response.end('{}'); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw); requests.push(input);
    const implementing = String(input.messages.at(-1)?.content).startsWith('Implement the reviewed plan');
    response.end(JSON.stringify({ message: { role: 'assistant', content: implementing ? 'The reviewed plan is now active.' : `<proposed_plan>\n${proposal}\n</proposed_plan>` }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const env = { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath, env, timeout: 30000 });
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(async port => window.desktop.updateSettings({ connections: [{ id: 'plan-fixture', provider: 'ollama', label: 'Plan fixture', url: `http://127.0.0.1:${port}` }], mainModel: { provider: 'ollama', connectionId: 'plan-fixture', model: 'plan-fixture', contextLimit: 32000 }, plannerModel: null, subagentModel: null }), port);
    await page.getByLabel('Message', { exact: true }).fill('/plan');
    await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Plan mode', exact: true })).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByLabel('Message', { exact: true }).fill('Design an export workflow with presets');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const implement = page.getByRole('button', { name: 'Implement plan', exact: true });
    await expect(implement).toBeEnabled({ timeout: 30000 });
    expect(requests[0].tools.some((tool: any) => tool.function.name === 'create_file')).toBe(false);
    await implement.click();
    await expect(page.getByText('The reviewed plan is now active.', { exact: true })).toBeVisible();
    const card = page.getByRole('region', { name: 'Saved work plan', exact: true });
    await expect(card).toBeVisible();
    await card.getByText('Steps', { exact: true }).click();
    const firstStep = card.getByRole('checkbox', { name: 'Inspect the current flow', exact: true });
    await firstStep.click();
    await expect(firstStep).toBeChecked();
    await expect(card).toContainText('1 of 3 complete');
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const saved = snapshot.chats[0];
    expect(saved.collaborationMode).toBe('default');
    expect(saved.workPlan!.steps[0].status).toBe('completed');
    expect(requests[1].messages.at(-1).content).toContain(proposal);
    expect(errors).toEqual([]);
    await app.close();
    app = await electron.launch({ executablePath, env, timeout: 30000 });
    page = await app.firstWindow();
    const restored = await page.evaluate(id => window.desktop.snapshot().then(state => state.chats.find(chat => chat.id === id)), saved.id);
    expect(restored!.workPlan!.steps[0].status).toBe('completed');
    expect(restored!.workPlan!.revision).toBe(saved.workPlan!.revision);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
