import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

test('hides unavailable connections, restores cached models quietly, and persists role selections', async () => {
  test.setTimeout(60_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-settings-'));
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  let app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    const fixture = await page.evaluate(async () => {
      const connections = [
        { id: 'this-lm', provider: 'lmstudio' as const, label: 'LM Studio on this computer', url: 'http://127.0.0.1:1234' },
        { id: 'tail-lm', provider: 'lmstudio' as const, label: 'Remote LM Studio', url: 'http://100.80.53.57:1234', deviceId: '100.80.53.57', deviceLabel: 'Desktop (Tailscale)' },
        { id: 'tail-ollama', provider: 'ollama' as const, label: 'Remote Ollama', url: 'http://100.80.53.57:11434' },
        { id: 'empty', provider: 'ollama' as const, label: 'Empty server', url: 'http://empty-server:11434' },
        { id: 'openai', provider: 'openai' as const, label: 'OpenAI API', url: 'https://api.openai.com' },
        { id: 'claude', provider: 'claude' as const, label: 'Claude API', url: 'https://api.anthropic.com' },
      ];
      const models = connections.filter(item => item.id !== 'empty').map(item => ({ provider: item.provider, connectionId: item.id, connectionLabel: item.label, id: 'same-model', label: 'Same model', available: true }));
      await window.desktop.updateSettings({ connections, mainModel: { provider: 'lmstudio', connectionId: 'tail-lm', model: 'same-model', contextLimit: 8192 }, plannerModel: null, subagentModel: null });
      return { connections: connections.filter(item => item.id !== 'this-lm'), models: models.filter(item => item.connectionId !== 'this-lm'), applications: [], diagnostics: [] };
    });
    await app.evaluate(({ ipcMain, BrowserWindow }, fixture) => {
      const state = globalThis as any;
      state.settingsFixture = fixture; state.explicitRefreshes = 0;
      // The context bridge is frozen. Mock IPC handlers in the isolated test app.
      for (const name of ['autoDiscover', 'cachedDiscovery', 'connectCodex']) ipcMain.removeHandler('api:' + name);
      ipcMain.handle('api:cachedDiscovery', () => state.settingsFixture);
      ipcMain.handle('api:autoDiscover', () => { state.explicitRefreshes++; return state.settingsFixture; });
      ipcMain.handle('api:connectCodex', () => { state.codexClicked = true; throw new Error('Fixture sign-in cancelled'); });
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel: string, ...args: any[]) => {
        if (channel !== 'discovery:update') send(channel, ...args);
      };
    }, fixture);
    await expect(page.getByText('Your models. Your space.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Try a model. Ask anything.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(page.getByRole('heading', { name: 'ChatGPT sign-in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API keys', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect with Codex' })).toBeEnabled();
    await page.getByRole('button', { name: 'Connect with Codex' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Fixture sign-in cancelled' })).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).codexClicked)).toBe(true);
    await expect(page.getByRole('button', { name: /Manage ChatGPT usage|Use an OpenAI API key/ })).toHaveCount(0);
    await expect(page.getByLabel('API provider')).toHaveValue('claude');
    await expect(page.locator('.connection-box')).toHaveCount(3);
    const local = page.locator('.connection-box').filter({ has: page.getByRole('heading', { name: 'This computer' }) });
    const remote = page.locator('.connection-box').filter({ has: page.getByRole('heading', { name: 'Desktop (Tailscale)' }) });
    await expect(local).toHaveCount(0);
    await expect(local.locator('input')).toHaveCount(0);
    await expect(remote.locator('li')).toHaveCount(2);
    await expect(remote.locator('input')).toHaveCount(2);
    await expect(page.locator('.connection-box').filter({ hasText: 'Empty server' })).toHaveCount(0);
    await expect(page.getByText(/No models available/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scanning…' })).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).explicitRefreshes)).toBe(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: /Model settings/ }).click();
    await expect(remote.locator('li')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Scanning…' })).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).explicitRefreshes)).toBe(0);
    await page.screenshot({ path: 'test-results/model-settings-connections.png' });
    await page.getByLabel('Planner model', { exact: true }).focus();
    await expect(page.getByRole('note').filter({ hasText: 'Plans project infrastructure' })).toBeVisible();
    await page.getByLabel('Planner model', { exact: true }).selectOption(JSON.stringify(['tail-lm', 'same-model']));
    await page.getByLabel('Subagent model', { exact: true }).focus();
    await page.getByLabel('Subagent model', { exact: true }).selectOption(JSON.stringify(['tail-ollama', 'same-model']));
    await expect(page.getByRole('note').filter({ hasText: 'Breaks down data' })).toBeVisible();
    await page.getByLabel('Context limit · Main model').fill('16384');
    await page.screenshot({ path: 'test-results/model-settings-roles.png' });
    await page.setViewportSize({ width: 700, height: 900 });
    await page.screenshot({ path: 'test-results/model-settings-narrow.png' });
    expect(await page.locator('.settings-modal').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await app.evaluate(() => { (globalThis as any).settingsFixture.connections = []; (globalThis as any).settingsFixture.models = []; });
    await page.locator('.settings-modal').getByRole('button', { name: 'Refresh models', exact: true }).click();
    await expect(page.getByLabel(/Concurrent requests per model/)).toHaveCount(0);
    await expect(remote).toHaveCount(0);
    await expect(page.getByText(/No models available/)).toBeVisible();
    await page.getByRole('button', { name: 'Save settings' }).click();
    const settings = await page.evaluate(() => window.desktop.snapshot().then(state => state.settings));
    expect(settings.mainModel?.contextLimit).toBe(16384);
    expect(settings.plannerModel?.connectionId).toBe('tail-lm');
    expect(settings.subagentModel?.connectionId).toBe('tail-ollama');
    await app.close();
    app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
    page = await app.firstWindow();
    const restored = await page.evaluate(() => window.desktop.snapshot().then(state => state.settings));
    expect(restored.mainModel).toEqual(settings.mainModel);
    expect(restored.plannerModel).toEqual(settings.plannerModel);
    expect(restored.subagentModel).toEqual(settings.subagentModel);
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});
