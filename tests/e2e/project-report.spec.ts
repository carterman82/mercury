import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../src/main/store';

test('real report button survives close/reopen, renders, caches, saves and shows errors', async () => {
  test.setTimeout(120000);
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-report-ui-'));
  const realProject = process.env.MERCURY_REPORT_REAL_UI === '1';
  const root = realProject ? path.resolve('D:/Claude/Wordpress') : path.join(data, 'project');
  if (!realProject) {
    await fs.mkdir(path.join(root, '.mercury/architecture/generated'), { recursive: true });
    await fs.writeFile(path.join(root, '.mercury/architecture/system.mmd'), 'flowchart LR\nMain --> Storage');
    await fs.writeFile(path.join(root, '.mercury/architecture/generated/files.mmd'), 'flowchart LR\nStorage --> CMS');
    await fs.writeFile(path.join(root, '.mercury/architecture/graph.json'), 'This must never be read or rebuilt by a report.');
  }
  const graphTimestamp = (await fs.stat(path.join(root, '.mercury/architecture/graph.json'))).mtimeMs;
  const diagram = realProject ? (await fs.readFile('test-results/live-reports/Wordpress.mmd', 'utf8')).trim() : 'flowchart LR\nScripts[Scripts] --> Main[Main]\nMain --> Storage[Content Storage]\nStorage --> CMS[Publishing CMS]';
  const content = realProject ? await fs.readFile('test-results/live-reports/Wordpress.md', 'utf8') : '```mermaid\n' + diagram + '\n```\n\nMain orchestrates content storage and publishing.';
  let summaries = 0, finalRequests = 0, failing = false;
  const analyzedSources: string[][] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') { response.end(JSON.stringify({ models: ['main', 'fast'].map(key => ({ key, type: 'llm', max_context_length: 8192, loaded_instances: [{ id: key, config: { context_length: 8192, parallel: 4 } }] })), data: [{ id: 'main' }, { id: 'fast' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    const input = JSON.parse(raw);
    if (request.url !== '/api/v1/chat') { response.statusCode = 404; response.end('{}'); return; }
    if (input.model === 'fast') {
      summaries++;
      if (failing) { response.statusCode = 500; response.end(JSON.stringify({ error: 'Report fixture failure' })); return; }
      await hold;
    } else finalRequests++;
    let answer = content;
    if (input.model === 'fast') {
      try {
        const { fragments } = JSON.parse(input.input ?? input.messages?.at(-1)?.content ?? '');
        analyzedSources.push(fragments.map((fragment: any) => fragment.source));
        answer = JSON.stringify({ summaries: fragments.map((fragment: any) => ({ id: fragment.id, summary: 'Main orchestrates storage and publishing.' })) });
      } catch { answer = 'Main orchestrates storage and publishing.'; }
    }
    response.end(JSON.stringify({ output: [{ type: 'message', content: answer }], stats: { total_output_tokens: 100 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const profile = { provider: 'lmstudio' as const, connectionId: 'report-fixture', endpoint: `http://127.0.0.1:${port}`, model: 'main', contextLimit: 8192 };
  const store = new Store(path.join(data, 'state.sqlite'));
  const projectId = randomUUID(), chatId = randomUUID();
  store.saveSettings({ connections: [{ id: 'report-fixture', provider: 'lmstudio', label: 'Local report fixture', url: profile.endpoint }], mainModel: profile, plannerModel: null, subagentModel: { ...profile, model: 'fast' } });
  store.saveProject({ id: projectId, path: root, name: 'Report UI fixture', permissionMode: 2, policyRevision: 1 });
  store.saveChat({ id: chatId, projectId, title: 'Report test chat', profile, messages: [], status: 'idle', updatedAt: Date.now() });
  store.close();
  const workspaceApp = process.env.MERCURY_WORKSPACE_APP === '1';
  const launch = () => electron.launch({ executablePath: workspaceApp ? path.resolve('node_modules/electron/dist/electron.exe') : path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe'), args: workspaceApp ? [path.resolve('.')] : [], env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  let app = await launch();
  try {
    await app.evaluate(({ shell }) => {
      (globalThis as any).reportFileOpens = [];
      shell.openPath = async value => { (globalThis as any).reportFileOpens.push(value); return ''; };
      shell.showItemInFolder = value => { (globalThis as any).reportFileOpens.push(value); };
    });
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: '▱ Report UI fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Report test chat', exact: true }).click();
    await page.getByRole('button', { name: 'Generate Report', exact: true }).click();
    await expect.poll(() => summaries).toBeGreaterThan(0);
    await expect(page.locator('.project-maps-panel [role=status]')).toContainText('Analyzing');
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    await page.getByRole('button', { name: 'Generate Report', exact: true }).click();
    await expect(page.locator('.project-maps-panel [role=status]')).toContainText('rejoining');
    release();
    await expect(page.locator('.project-map-canvas svg')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('.project-map-canvas')).toContainText(realProject ? 'Generator' : 'Content Storage');
    await expect(page.locator('.project-maps-panel')).toContainText(realProject ? 'Core Orchestration' : 'Main orchestrates content storage and publishing.');
    const completedSummaries = summaries;
    if (!realProject) expect(summaries).toBe(1);
    expect(finalRequests).toBe(1);
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: realProject ? 'test-results/report-actual-wordpress-app.png' : 'test-results/report-actual-app.png' });
    const saved = path.join(data, 'saved-report.mmd');
    await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, saved);
    await page.getByRole('button', { name: 'Save .mmd', exact: true }).click();
    await expect.poll(async () => fs.readFile(saved, 'utf8').catch(() => '')).toBe(diagram);
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    await expect(page.locator('.context-panel')).toHaveCount(1);
    await page.getByRole('button', { name: 'Generate Report', exact: true }).click();
    await expect(page.locator('.project-map-canvas svg')).toBeVisible();
    expect(summaries).toBe(completedSummaries); expect(finalRequests).toBe(1);
    expect(await app.evaluate(() => (globalThis as any).reportFileOpens)).toEqual([]);
    expect((await fs.stat(path.join(root, '.mercury/architecture/graph.json'))).mtimeMs).toBe(graphTimestamp);
    if (!realProject) await expect(fs.stat(path.join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Relaunch the real application with the same saved profile and no in-memory jobs.
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: '▱ Report UI fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Report test chat', exact: true }).click();
    await page.getByRole('button', { name: 'Generate Report', exact: true }).click();
    await expect(page.locator('.project-map-canvas svg')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update Report', exact: true })).toBeEnabled();
    expect(summaries).toBe(completedSummaries); expect(finalRequests).toBe(1);
    await expect(page.locator('.project-maps-panel')).toContainText('Source commit:');
    if (!realProject) {
      await fs.writeFile(path.join(root, '.mercury/architecture/generated/files.mmd'), 'flowchart LR\nStorage --> UpdatedCMS');
      await page.getByRole('button', { name: 'Update Report', exact: true }).click();
      await expect.poll(() => finalRequests).toBe(2);
      await expect(page.getByRole('button', { name: 'Update Report', exact: true })).toBeEnabled();
      expect(summaries).toBe(completedSummaries + 1);
      expect(analyzedSources.at(-1)).toEqual(['generated/files.mmd']);
    }
    const cacheDirectory = path.join(data, 'project-reports');
    const cacheFile = path.join(cacheDirectory, (await fs.readdir(cacheDirectory)).find(name => name.endsWith('.json'))!);
    const successfulCache = await fs.readFile(cacheFile, 'utf8');
    failing = true;
    await page.getByRole('button', { name: 'Start from scratch', exact: true }).click();
    await expect(page.locator('.project-maps-panel [role=alert]')).toContainText('500');
    await expect(page.locator('.project-map-canvas svg')).toBeVisible();
    expect(await fs.readFile(cacheFile, 'utf8')).toBe(successfulCache);
  } finally {
    release(); await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(data, { recursive: true, force: true });
  }
});
