import { test, expect, _electron as electron } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('opens a selected folder through desktop IPC without building dependency maps', async () => {
  test.setTimeout(90000);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-project-open-'));
  const root = process.env.MERCURY_OPEN_PROJECT_PATH ?? path.join(data, 'fixture-project');
  if (!process.env.MERCURY_OPEN_PROJECT_PATH) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'app.js'), 'console.log("fixture");\n');
  }
  const maps = path.join(root, '.mercury', 'architecture');
  const previousMaps = await fs.stat(maps).catch(() => null);
  const app = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: [path.resolve('.')],
    env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data },
  });
  try {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, root);
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.locator('main').getByRole('button', { name: 'Open project', exact: true }).click();
    await expect(page.getByRole('heading', { name: path.basename(root), exact: true })).toBeVisible({ timeout: 30000 });
    const projects = await page.evaluate(async () => (await window.desktop.snapshot()).projects);
    expect(projects).toEqual(expect.arrayContaining([expect.objectContaining({ path: await fs.realpath(root) })]));
    if (!previousMaps) expect(await fs.stat(maps).catch(() => null)).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
