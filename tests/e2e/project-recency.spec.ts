import { test, expect } from '@playwright/test';
import { createServer } from 'vite';

test.use({ channel: process.platform === 'win32' ? 'msedge' : undefined });

test('project, existing chat, and legacy history visits move their project to the top', async ({ page }) => {
  test.setTimeout(120000);
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'project-recency-test', configureServer(server) {
    server.middlewares.use('/__project_recency_test', async (_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(await server.transformIndexHtml('/__project_recency_test', `<!doctype html><html><body><div id="root"></div><script type="module">
        const profile = { provider: 'ollama', model: 'test', contextLimit: 32000 };
        const projects = [{ id: 'alpha', name: 'Alpha', path: 'C:/alpha', permissionMode: 3, lastUsedAt: 200 }, { id: 'beta', name: 'Beta', path: 'C:/beta', permissionMode: 3, lastUsedAt: 100 }];
        const state = { projects, sessions: [{ id: 'legacy', projectId: 'alpha', objective: 'Older work', status: 'completed', events: [], changes: [] }], chats: [{ id: 'beta-chat', projectId: 'beta', title: 'Beta task', profile, status: 'idle', messages: [], updatedAt: 1 }], settings: { connections: [], mainModel: profile, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null };
        const discovery = { connections: [], models: [], applications: [], diagnostics: [] };
        let update, time = 200;
        window.visits = [];
        window.desktop = {
          snapshot: async () => structuredClone(state), onUpdate: listener => { update = listener; return () => {}; }, onChatUpdate: () => () => {}, onDiscovery: () => () => {}, cachedDiscovery: async () => discovery,
          touchProject: async id => { window.visits.push(id); const project = state.projects.find(item => item.id === id); project.lastUsedAt = ++time; state.projects.sort((a, b) => b.lastUsedAt - a.lastUsedAt); update(structuredClone(state)); return project; }
        };
        await import('/src/renderer/main.tsx');
      </script></body></html>`));
    });
  } }] });
  try {
    await server.listen();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0] + '__project_recency_test');
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const names = page.locator('.project-item');
    await expect(names).toHaveText(['▱ Alpha', '▱ Beta']);
    await names.filter({ hasText: 'Beta' }).click();
    await expect(names).toHaveText(['▱ Beta', '▱ Alpha']);
    await names.filter({ hasText: 'Alpha' }).click();
    await expect(names).toHaveText(['▱ Alpha', '▱ Beta']);
    await page.getByRole('button', { name: 'Beta task', exact: true }).click();
    await expect(names).toHaveText(['▱ Beta', '▱ Alpha']);
    await page.getByText('Legacy history · read only', { exact: true }).click();
    await page.getByRole('button', { name: 'Older work completed', exact: true }).click();
    await expect(names).toHaveText(['▱ Alpha', '▱ Beta']);
    await expect(page.getByRole('heading', { name: 'Older work', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).visits)).toEqual(['beta', 'alpha', 'beta', 'alpha']);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
