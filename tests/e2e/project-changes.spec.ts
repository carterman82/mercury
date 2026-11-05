import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import path from 'node:path';

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ configFile: path.resolve('vite.renderer.config.ts'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'project-diff-fixture', configureServer(vite) {
    vite.middlewares.use('/__diff-fixture', async (_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(await vite.transformIndexHtml('/__diff-fixture', '<div id="root"></div><script type="module" src="/tests/e2e/project-diff-fixture.tsx"></script>'));
    });
  } }] });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });

test('opens the lazy difference editor, switches files, and closes with Escape', async ({ page }) => {
  test.setTimeout(60_000);
  const address = server.httpServer!.address() as { port: number };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__diff-fixture`);
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.getByRole('dialog', { name: 'Project changes' })).toBeVisible();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByLabel('Read-only differences for app.ts')).toBeVisible();
  await page.getByLabel('Changed file', { exact: true }).selectOption('image.png');
  await expect(page.getByText('Binary files and files larger than 512 KB are listed without a text preview.')).toBeVisible();
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0);
  await page.getByLabel('Changed file', { exact: true }).selectOption('app.ts');
  await expect(page.locator('.monaco-diff-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});
