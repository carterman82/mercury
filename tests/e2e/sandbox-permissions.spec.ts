import { test, expect, _electron as electron } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('persists Codex-style permission modes through the packaged desktop app', async () => {
  test.setTimeout(90000);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-permissions-ui-'));
  const root = path.join(data, 'Sandbox fixture');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'index.js'), 'console.log("fixture");\n');
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const env = { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data };
  let app = await electron.launch({ executablePath, env, timeout: 30000 });
  try {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, root);
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.locator('main').getByRole('button', { name: 'Open project', exact: true }).click();
    const permissions = page.getByLabel('Project permission mode', { exact: true });
    await expect(permissions).toHaveValue('2');
    await expect(permissions.locator('option')).toHaveText(['1 · Read-only', '2 · Workspace write', '3 · Full access']);
    for (const mode of ['1', '3', '2']) {
      await permissions.selectOption(mode);
      await expect.poll(() => page.evaluate(async () => (await window.desktop.snapshot()).projects[0].permissionMode)).toBe(Number(mode));
    }
    expect(errors).toEqual([]);
    await app.close();
    app = await electron.launch({ executablePath, env, timeout: 30000 });
    page = await app.firstWindow();
    expect(await page.evaluate(async () => (await window.desktop.snapshot()).projects[0].permissionMode)).toBe(2);
  } finally {
    await app.close();
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
