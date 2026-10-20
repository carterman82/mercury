import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unzipSync } from 'fflate';

async function drop(page: Page, filenames: string[]) {
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'format-drop'; input.style.display = 'none'; document.body.appendChild(input); });
  await page.locator('#format-drop').setInputFiles(filenames);
  await page.evaluate(() => {
    const input = document.getElementById('format-drop') as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    document.querySelector('.chat-layout')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); input.remove();
  });
}

test('generates common native files and re-reads Office files, images, scans, archives, and unknown binaries', async () => {
  test.setTimeout(120_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-standard-files-'));
  const names = ['report.docx', 'budget.xlsx', 'briefing.pptx', 'diagram.png', 'bundle.zip'];
  let stage = 0, inspected = false;
  const errors: string[] = [];
  const created: any[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'format-model' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const calls: any[] = [];
    let text = '';
    const toolMessages = input.messages.filter((message: any) => message.role === 'tool');
    for (const message of toolMessages) {
      const value = JSON.parse(message.content);
      if (value.error) errors.push(value.error);
      if (value.created && !created.some(file => file.id === value.created.id)) created.push(value.created);
    }
    if (stage++ === 0) {
      calls.push(
        { function: { name: 'create_document', arguments: { name: names[0], content: '# File support report\n\n## Findings\n\nThe **test revenue** is 1250.\n\n| Format | Status |\n|---|---|\n| Word | Ready |' } } },
        { function: { name: 'create_spreadsheet', arguments: { name: names[1], sheets: [{ name: 'Budget', rows: [['Item', 'Amount'], ['Travel', 1250]] }] } } },
        { function: { name: 'create_presentation', arguments: { name: names[2], title: 'File support', slides: [{ title: 'Findings', bullets: ['Office files are supported', 'No image model is needed'], notes: 'Speaker note verified.' }] } } },
        { function: { name: 'create_graphic', arguments: { name: names[3], width: 900, height: 220, background: '#ffffff', elements: [{ type: 'rect', x: 20, y: 20, width: 860, height: 180, fill: '#edf4f8' }, { type: 'text', x: 60, y: 130, text: 'Mercury file support 2026', fontSize: 50, fill: '#142b42' }] } } },
      );
    } else if (stage === 2) {
      if (errors.length) text = 'Errors: ' + errors.join('\n');
      else calls.push({ function: { name: 'create_archive', arguments: { name: names[4], files: created.map(file => ({ name: file.name, fileId: file.id })) } } });
    } else if (input.messages.at(-1).role === 'user') {
      const last = input.messages.at(-1).content;
      inspected = ['test revenue', '1250', 'Office files are supported', 'Mercury file support 2026', 'metadata', 'scanned.pdf'].every(fragment => last.includes(fragment));
      text = 'All supported contents inspected; unknown.binary has metadata only.';
    } else text = 'Your standard files are ready.';
    response.end(JSON.stringify({ message: { content: text, ...(calls.length ? { tool_calls: calls } : {}) }, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const app = await electron.launch({ executablePath, env: { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data } });
  try {
    const page = await app.firstWindow();
    await page.evaluate(port => window.desktop.updateSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Formats fixture', url: `http://127.0.0.1:${port}` }], mainModel: { provider: 'ollama', connectionId: 'fixture', model: 'format-model', contextLimit: 65536 }, plannerModel: null, subagentModel: null }), port);
    await app.evaluate(({ dialog }, destinations) => { dialog.showSaveDialog = async (_window: any, options: any) => ({ canceled: false, filePath: destinations[String(options.defaultPath).split(/[\\/]/).at(-1)!] }); }, Object.fromEntries(names.map(name => [name, path.join(data, name)])));
    await page.getByLabel('Message', { exact: true }).fill('Create a Word report, Excel budget, PowerPoint briefing, diagram, and ZIP bundle.');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect.poll(() => errors.length ? errors.join('\n') : created.length, { timeout: 30_000 }).toBe(5);
    for (const name of names) await page.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    await expect.poll(() => { try { return readFileSync(path.join(data, 'bundle.zip')).subarray(0, 2).toString(); } catch { return ''; } }).toBe('PK');
    for (const name of names.slice(0, 3)) expect(readFileSync(path.join(data, name)).subarray(0, 2).toString()).toBe('PK');
    const members = unzipSync(readFileSync(path.join(data, 'bundle.zip')));
    expect(Object.keys(members)).toEqual(expect.arrayContaining(names.slice(0, 4)));
    copyFileSync(path.join(data, 'diagram.png'), 'test-results/mercury-generated-graphic.png');
    const scan = await app.evaluate(async ({ BrowserWindow }, image) => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, javascript: false } });
      try { await window.loadURL(`data:text/html,<html><body><img style="width:650px" src="data:image/png;base64,${image}"></body></html>`); return (await window.webContents.printToPDF({ pageSize: 'Letter' })).toString('base64'); }
      finally { window.destroy(); }
    }, readFileSync(path.join(data, 'diagram.png')).toString('base64'));
    writeFileSync(path.join(data, 'scanned.pdf'), scan, 'base64');
    writeFileSync(path.join(data, 'unknown.binary'), Buffer.from([0, 255, 1, 0, 13, 8]));
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await drop(page, [...names.map(name => path.join(data, name)), path.join(data, 'scanned.pdf'), path.join(data, 'unknown.binary')]);
    await expect(page.locator('.pending-files')).toContainText('unknown.binary · metadata only', { timeout: 60_000 });
    await page.getByLabel('Message', { exact: true }).fill('Read and account for these files.');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toContainText('metadata only');
    expect(inspected).toBe(true);
    const state = await page.evaluate(() => window.desktop.snapshot());
    const uploads = state.chats.find(chat => chat.title === 'Read and account for these files.')!.messages[0].files!;
    const png = uploads.find(file => file.name === 'diagram.png')!;
    const pdf = uploads.find(file => file.name === 'scanned.pdf')!;
    expect(png.note).toContain('OCR'); expect(pdf.readStatus).toBe('partial');
    await page.screenshot({ path: 'test-results/mercury-standard-file-cards.png' });
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
