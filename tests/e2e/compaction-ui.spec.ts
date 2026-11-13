import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

test.use({ channel: process.platform === 'win32' ? 'msedge' : undefined });

// Exercise the actual renderer in a browser with only the desktop IPC boundary replaced.
test('shows compaction phases, resumes, and keeps Stop usable during compaction', async ({ page }) => {
  test.setTimeout(120000);
  const harness = (server: ViteDevServer) => {
  server.middlewares.use('/__compaction_test', async (_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(await server.transformIndexHtml('/__compaction_test', `<!doctype html><html><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatPanel } from '/src/renderer/ChatPanel.tsx';
      import '/src/renderer/style.css';
      const profile = { provider: 'ollama', connectionId: 'fixture', model: 'test', contextLimit: 32000 };
      const state = { projects: [{ id: 'project', name: 'Fixture', path: 'C:/fixture', permissionMode: 3 }], sessions: [], chats: [{ id: 'chat', projectId: 'project', title: 'Task', profile, messages: [{ id: 'reply', role: 'assistant', content: '', compaction: { phase: 'saving', startedAt: Date.now() } }], status: 'streaming', updatedAt: 1 }], settings: { connections: [], mainModel: profile, plannerModel: null, subagentModel: null }, activeRole: null, activeChatId: null };
      const root = createRoot(document.getElementById('root'));
      const render = () => root.render(React.createElement(ChatPanel, { state: structuredClone(state), chatId: 'chat', onSelect() {}, openSettings() {} }));
      window.desktop = { onDiscovery: () => () => {}, cachedDiscovery: async () => ({ connections: [], models: [], applications: [], diagnostics: [] }), stopChat: async () => { state.chats[0].status = 'stopped'; render(); } };
      window.setPhase = phase => { state.chats[0].messages[0].compaction.phase = phase; render(); };
      render();
    </script></body></html>`));
  });
  };
  const server = await createServer({ configFile: false, plugins: [{ name: 'compaction-test-harness', configureServer: harness }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0] + '__compaction_test');
    const bar = page.getByRole('progressbar', { name: 'Automatic context compaction' });
    await expect(bar).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('Saving task handoff…')).toBeVisible();
    await page.evaluate(() => (window as any).setPhase('compacting'));
    await expect(page.getByText('Compacting context…')).toBeVisible();
    await page.evaluate(() => (window as any).setPhase('resuming'));
    await expect(page.getByText('Resuming saved work…')).toBeVisible();
    await page.evaluate(() => (window as any).setPhase('completed'));
    await expect(bar).toHaveCount(0);
    await page.evaluate(() => (window as any).setPhase('compacting'));
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect(bar).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
