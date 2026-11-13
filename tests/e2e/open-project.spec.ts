import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test.use({ channel: process.platform === 'win32' ? 'msedge' : undefined });

test('shows pending project opening, prevents duplicates, and recovers on success, cancel and failure', async ({ page }) => {
  test.setTimeout(120000);
  const server = await createServer({
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'open-project-test', configureServer(server) {
      server.middlewares.use('/__open_project_test', async (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(await server.transformIndexHtml('/__open_project_test', `<!doctype html><html><body><div id="root"></div><script type="module">
          const state = { projects: [], sessions: [], chats: [], settings: { connections: [], mainModel: null, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null };
          const discovery = { connections: [], models: [], applications: [], diagnostics: [] };
          let update, resolveOpen, rejectOpen;
          window.openCalls = 0;
          window.desktop = {
            snapshot: async () => structuredClone(state),
            onUpdate: listener => { update = listener; return () => {}; },
            onChatUpdate: () => () => {}, onDiscovery: () => () => {},
            cachedDiscovery: async () => discovery, autoDiscover: async () => discovery,
            openProject: () => { window.openCalls++; return new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; }); }
          };
          window.finishOpen = outcome => {
            if (outcome === 'error') { rejectOpen(new Error('Project could not be read.')); return; }
            if (outcome === 'cancel') { resolveOpen(null); return; }
            const project = { id: 'project', name: 'Large project', path: 'C:/large-project', permissionMode: 2 };
            state.projects = [project]; update(structuredClone(state)); resolveOpen(project);
          };
          await import('/src/renderer/main.tsx');
        </script></body></html>`));
      });
    } }],
  });
  try {
    await server.listen();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0] + '__open_project_test');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const sidebar = page.locator('aside').getByRole('button', { name: /Open project/ });
    const welcome = page.locator('main').getByRole('button', { name: 'Open project', exact: true });
    const status = page.getByRole('status').filter({ hasText: 'Opening project' });

    await welcome.click();
    await expect(status).toBeVisible();
    await expect(status).toContainText('Large folders');
    await expect(sidebar).toBeDisabled();
    await expect(welcome).toBeDisabled();
    expect(await page.evaluate(() => (window as any).openCalls)).toBe(1);
    await page.evaluate(() => (window as any).finishOpen('cancel'));
    await expect(status).toHaveCount(0);
    await expect(sidebar).toBeEnabled();
    await expect(welcome).toBeEnabled();

    await sidebar.click();
    await expect(status).toBeVisible();
    await page.evaluate(() => (window as any).finishOpen('error'));
    await expect(status).toHaveCount(0);
    await expect(page.getByText('Project could not be read.')).toBeVisible();
    await expect(sidebar).toBeEnabled();

    await sidebar.click();
    await expect(status).toBeVisible();
    await page.evaluate(() => (window as any).finishOpen('success'));
    await expect(status).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Large project', exact: true })).toBeVisible();
    await expect(page.getByText('Project could not be read.')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
