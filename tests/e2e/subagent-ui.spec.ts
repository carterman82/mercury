import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

test.use({ channel: process.platform === 'win32' ? 'msedge' : undefined });

test('keeps the top subagent panel hidden as background workers progress', async ({ page }) => {
  test.setTimeout(120000);
  const harness = (server: ViteDevServer) => {
    server.middlewares.use('/__subagent_test', async (_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(await server.transformIndexHtml('/__subagent_test', `<!doctype html><html><body><div id="root"></div><script type="module">
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ChatPanel } from '/src/renderer/ChatPanel.tsx';
        import '/src/renderer/style.css';
        const profile = { provider: 'ollama', model: 'worker-model', contextLimit: 32000 };
        const workers = ['Inspect the source', 'Review the tests'].map((task, index) => ({ id: 'worker-' + index, kind: 'investigation', task, context: '', ownedPaths: [], checks: [], profile, status: index ? 'queued' : 'running', createdAt: 1, updatedAt: 1 }));
        const state = { projects: [{ id: 'project', name: 'Subagent preview', path: 'C:/fixture', permissionMode: 3 }], sessions: [], chats: [{ id: 'chat', projectId: 'project', title: 'Task', profile, projectAssignments: workers, messages: [{ id: 'reply', role: 'assistant', content: '' }], status: 'streaming', updatedAt: 1 }], settings: { connections: [], mainModel: profile, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null };
        window.desktop = { onDiscovery: () => () => {}, cachedDiscovery: async () => ({ connections: [], models: [], applications: [], diagnostics: [] }) };
        const root = createRoot(document.getElementById('root'));
        const render = () => root.render(React.createElement(ChatPanel, { state: structuredClone(state), chatId: 'chat', onSelect() {}, openSettings() {} }));
        window.finishWorkers = () => { workers[0].status = 'completed'; workers[0].findings = 'Found the entry point.'; workers[0].activity = [{ name: 'run_project_process', status: 'succeeded', at: 1, result: 'Source check passed' }]; workers[1].status = 'failed'; workers[1].error = 'Provider disconnected'; render(); };
        render();
      </script></body></html>`));
    });
  };
  const server = await createServer({ configFile: false, plugins: [{ name: 'subagent-ui-harness', configureServer: harness }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0] + '__subagent_test');
    await expect(page.getByRole('heading', { name: 'Subagent preview' })).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.project-worker-activity')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    await page.evaluate(() => (window as any).finishWorkers());
    await expect(page.locator('.project-worker-activity')).toHaveCount(0);
    await expect(page.getByText('Subagents ·')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
