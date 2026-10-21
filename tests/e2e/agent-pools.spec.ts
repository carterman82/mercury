import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('adds, reorders, removes, and restores local Main and Subagent pools', async () => {
  test.setTimeout(60_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-agent-pools-'));
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  let app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    let page = await app.firstWindow();
    await page.setViewportSize({ width: 1100, height: 900 });
    const discovery = await page.evaluate(async () => {
      const connections = [
        { id: 'local', provider: 'lmstudio' as const, label: 'This computer', url: 'http://127.0.0.1:1234' },
        { id: 'remote', provider: 'lmstudio' as const, label: 'Desktop', url: 'http://device-b:1234', deviceId: 'b', deviceLabel: 'Desktop' },
      ];
      const models = connections.map(item => ({ id: 'gemma', label: 'Gemma', provider: item.provider, connectionId: item.id, connectionLabel: item.label, available: true, contextLimit: 32768 }));
      const profile = { provider: 'lmstudio' as const, model: 'gemma', connectionId: 'local', contextLimit: 8192 };
      await window.desktop.updateSettings({ connections, mainModel: profile, plannerModel: null, subagentModel: profile });
      return { connections, models, applications: [], diagnostics: [] };
    });
    await app.evaluate(({ ipcMain, BrowserWindow }, fixture) => {
      for (const method of ['cachedDiscovery', 'autoDiscover']) {
        ipcMain.removeHandler('api:' + method); ipcMain.handle('api:' + method, () => fixture);
      }
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => { if (channel !== 'discovery:update') send(channel, ...args); };
    }, discovery);
    await page.getByRole('button', { name: /Model settings/ }).click();
    await page.getByRole('button', { name: 'Add main model to pool', exact: true }).click();
    await expect(page.getByLabel('Main model 2', { exact: true })).toHaveValue(JSON.stringify(['remote', 'gemma']));
    await page.getByRole('button', { name: 'Move Main model 2 up', exact: true }).click();
    await expect(page.getByLabel('Main model', { exact: true })).toHaveValue(JSON.stringify(['remote', 'gemma']));
    await expect(page.getByLabel('Main model 2', { exact: true })).toHaveValue(JSON.stringify(['local', 'gemma']));
    await page.getByRole('button', { name: 'Add subagent model to pool', exact: true }).click();
    await expect(page.getByLabel('Subagent model 2', { exact: true })).toHaveValue(JSON.stringify(['remote', 'gemma']));
    await page.getByRole('button', { name: 'Remove Subagent model', exact: true }).click();
    await expect(page.getByLabel('Subagent model', { exact: true })).toHaveValue(JSON.stringify(['remote', 'gemma']));
    await page.getByRole('button', { name: 'Add subagent model to pool', exact: true }).click();
    await page.getByLabel('Context limit · Subagent model 2', { exact: true }).fill('4096');
    await page.screenshot({ path: 'test-results/agent-pools.png' });
    await page.setViewportSize({ width: 700, height: 900 });
    expect(await page.locator('.settings-modal').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    const saved = await page.evaluate(() => window.desktop.snapshot().then(state => state.settings));
    expect(saved.mainModel?.connectionId).toBe('remote');
    expect(saved.additionalMainModels?.map(item => item.connectionId)).toEqual(['local']);
    expect(saved.subagentModel?.connectionId).toBe('remote');
    expect(saved.additionalSubagentModels?.[0]).toMatchObject({ connectionId: 'local', contextLimit: 4096, contextMode: 'manual' });
    await app.close();
    app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
    page = await app.firstWindow();
    const restored = await page.evaluate(() => window.desktop.snapshot().then(state => state.settings));
    expect(restored.additionalMainModels).toEqual(saved.additionalMainModels);
    expect(restored.additionalSubagentModels).toEqual(saved.additionalSubagentModels);
    expect(restored.mainModel).toEqual(saved.mainModel);
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});

test('updates the model picker after automatic routing within an existing pooled chat', async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-pool-picker-'));
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const local = { provider: 'lmstudio', model: 'gemma', connectionId: 'local', contextLimit: 8192 };
      const remote = { ...local, connectionId: 'remote' };
      const connections = [
        { id: 'local', provider: 'lmstudio', label: 'Local', url: 'http://127.0.0.1:1234' },
        { id: 'remote', provider: 'lmstudio', label: 'Remote', url: 'http://device-b:1234' },
      ];
      const models = connections.map(item => ({ id: 'gemma', label: 'Gemma', provider: 'lmstudio', connectionId: item.id, connectionLabel: item.label, available: true }));
      const state = { projects: [], sessions: [], chats: [{ id: 'pooled', title: 'Pooled chat', profile: remote, usesMainPool: true, status: 'idle', updatedAt: 1, messages: [] as any[] }], settings: { connections, mainModel: local, additionalMainModels: [remote], plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null };
      const selected: string[] = []; (globalThis as any).poolPickerSelections = selected;
      for (const method of ['snapshot', 'cachedDiscovery', 'autoDiscover', 'sendChat']) ipcMain.removeHandler('api:' + method);
      ipcMain.handle('api:snapshot', () => state);
      for (const method of ['cachedDiscovery', 'autoDiscover']) ipcMain.handle('api:' + method, () => ({ connections, models, applications: [], diagnostics: [] }));
      ipcMain.handle('api:sendChat', (_event, _id, profile, message) => {
        selected.push(profile.connectionId);
        state.chats[0].profile = local;
        state.chats[0].messages.push({ id: `u${selected.length}`, role: 'user', content: message }, { id: `a${selected.length}`, role: 'assistant', content: 'Routed response', model: 'gemma' });
        BrowserWindow.getAllWindows()[0].webContents.send('state:update', state);
        return 'pooled';
      });
      BrowserWindow.getAllWindows()[0].webContents.reload();
    });
    await page.getByRole('button', { name: 'Pooled chat', exact: true }).click();
    await expect(page.getByLabel('Chat model', { exact: true })).toHaveValue(JSON.stringify(['remote', 'gemma']));
    await page.getByLabel('Message', { exact: true }).fill('Continue');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.getByLabel('Chat model', { exact: true })).toHaveValue(JSON.stringify(['local', 'gemma']));
    await page.getByLabel('Message', { exact: true }).fill('Continue again');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    expect(await app.evaluate(() => (globalThis as any).poolPickerSelections)).toEqual(['remote', 'local']);
  } finally { await app.close(); rmSync(data, { recursive: true, force: true }); }
});
