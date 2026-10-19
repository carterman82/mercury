import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';

async function dropFiles(page: Page, filenames: string[]) {
  // setInputFiles supplies genuine disk-backed File objects; JS-created Files
  // intentionally cannot cross the preload file-path boundary.
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'native-drop-fixture'; input.style.display = 'none'; document.body.appendChild(input); });
  await page.locator('#native-drop-fixture').setInputFiles(filenames);
  await page.evaluate(() => {
    const input = document.getElementById('native-drop-fixture') as HTMLInputElement;
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    const chat = document.querySelector('.chat-layout')!;
    chat.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    chat.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    chat.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    input.remove();
  });
}

test('uploads files, creates and saves a PDF, reads that PDF, and restores file cards', async () => {
  test.setTimeout(90_000);
  const data = mkdtempSync(path.join(os.tmpdir(), 'mercury-files-e2e-'));
  const source = path.join(data, 'problem.md');
  const saved = path.join(data, 'IVP_Solution.pdf');
  writeFileSync(source, "Initial value problem\nv'(x) = 8x^(1/3) - 4x^(-1/3)\nv(8) = 56, x > 0");
  const solution = [
    '# Initial Value Problem Solution',
    'A worked solution with a **verification report**, a reusable code example, and formatted mathematical notation.',
    '## Problem',
    "Find $v(x)$ given $v\\prime(x)=8x^{1/3}-4x^{-1/3}$, $v(8)=56$, and $x>0$.",
    '## Integrate',
    '$$v(x)=6x^{4/3}-6x^{2/3}+C$$',
    '1. Integrate each term using the power rule.\n2. Substitute the initial condition.\n3. Verify the resulting derivative.',
    '## Substitute the initial condition',
    '| Quantity | Evaluation |\n|---|---|\n| Initial value | **56** |\n| Value before the constant | $6(16)-6(4)=72$ |\n| Integration constant | C = −16 |',
    '## Final answer',
    '$$v(x)=6x^{4/3}-6x^{2/3}-16$$',
    '## Verification code',
    '```python\ndef velocity(x):\n    return 6*x**(4/3) - 6*x**(2/3) - 16\n\nassert round(velocity(8)) == 56\n```',
    '> The solution applies for positive x. The constant is fixed by the supplied initial value.',
    '## Verification data',
    '| Check | Input | Outcome |\n|---|---|---|\n' + Array.from({ length: 55 }, (_, index) => `| Case ${index + 1} | x = ${index + 1} | Finite value for positive input |`).join('\n'),
    '## Conclusion',
    'The initial condition and the derivative agree with the solution. This final section verifies that the complete report was printed.',
  ].join('\n\n');
  let created = false;
  let sawUpload = false;
  let sawToolResult = false;
  let toolError = '';
  let sawExtractedPdf = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'file-model' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    expect(input.tools.some((tool: any) => tool.function.name === 'create_pdf')).toBe(true);
    expect(input.messages[0].content).toContain('even if the user did not explicitly ask for a file');
    const last = input.messages.at(-1);
    let message: any;
    if (last.role === 'tool') {
      toolError = JSON.parse(last.content).error ?? '';
      sawToolResult = JSON.parse(last.content).created?.name === 'IVP_Solution.pdf';
      message = { content: 'Your PDF is ready.' };
    } else if (!created) {
      sawUpload = last.content.includes('v(8) = 56') && last.content.includes('problem.md');
      created = true;
      message = { content: '', tool_calls: [{ function: { name: 'create_pdf', arguments: { name: 'IVP_Solution.pdf', content: solution } } }] };
    } else {
      sawExtractedPdf = last.content.includes('IVP_Solution.pdf') && last.content.includes('Final answer') && last.content.includes('−16');
      message = { content: 'The uploaded PDF contains the complete IVP solution.' };
    }
    response.end(JSON.stringify({ message, done: true }) + '\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const executablePath = path.resolve('out', process.env.LOCAL_PLAN_AGENT_BUILD_ID ?? '', 'Mercury-win32-x64', 'Mercury.exe');
  const env = { ...process.env, LOCAL_PLAN_AGENT_USER_DATA: data };
  let app = await electron.launch({ executablePath, env });
  try {
    let page = await app.firstWindow();
    await page.evaluate(async port => window.desktop.updateSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Files fixture', url: `http://127.0.0.1:${port}` }], defaultModel: { provider: 'ollama', connectionId: 'fixture', model: 'file-model', contextLimit: 32768 }, overrides: {} }), port);
    await app.evaluate(({ dialog }, saved) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: saved }); }, saved);
    await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toHaveCount(0);
    await dropFiles(page, [source]);
    await expect(page.locator('.pending-files')).toContainText('problem.md');
    await page.getByLabel('Message', { exact: true }).fill('Analyze this IVP in detail');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect.poll(() => sawToolResult ? 'created' : toolError || 'pending').toBe('created');
    await expect(page.getByRole('button', { name: 'Save IVP_Solution.pdf', exact: true })).toBeVisible();
    await expect(page.locator('.chat-assistant')).toContainText('Your PDF is ready.');
    await page.getByRole('button', { name: 'Save IVP_Solution.pdf', exact: true }).click();
    await expect.poll(() => { try { return readFileSync(saved).subarray(0, 5).toString(); } catch { return ''; } }).toBe('%PDF-');
    expect(sawUpload).toBe(true); expect(sawToolResult).toBe(true);
    await page.getByRole('button', { name: 'New chat', exact: false }).click();
    await dropFiles(page, [saved]);
    await expect(page.locator('.pending-files')).toContainText('IVP_Solution.pdf', { timeout: 20_000 });
    await page.getByLabel('Message', { exact: true }).fill('Read this PDF');
    await page.getByRole('button', { name: 'Send ↑' }).click();
    await expect(page.locator('.chat-assistant')).toContainText('complete IVP solution');
    expect(sawExtractedPdf).toBe(true);
    await page.screenshot({ path: 'test-results/mercury-chat-files.png' });
    // Render the actual saved bytes for visual QA, not the original source text.
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const task = getDocument({ data: new Uint8Array(readFileSync(saved)) });
    try {
      const pdf = await task.promise;
      expect(pdf.numPages).toBeGreaterThanOrEqual(2);
      const texts: string[] = [];
      let titleHeight = 0;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const text = await page.getTextContent();
        texts.push(text.items.map(item => 'str' in item ? item.str : '').join(' '));
        for (const item of text.items) if ('str' in item && item.str === 'Initial Value Problem Solution') titleHeight = item.height;
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
        writeFileSync(`test-results/mercury-formatted-pdf-${index}.png`, canvas.toBuffer('image/png'));
      }
      expect(titleHeight).toBeGreaterThan(20);
      expect(texts.join(' ')).not.toContain('# Initial Value');
      expect(texts.join(' ')).not.toContain('|---|');
      expect(texts.join(' ')).not.toContain('```python');
      expect(texts.join(' ')).toContain('Case 55');
      expect(texts.some(text => /def\s+velocity/.test(text) && /assert\s+round/.test(text))).toBe(true);
      expect(texts.at(-1)).toContain('complete report was printed');
      // The long table continues across pages with a repeated header.
      expect(texts.filter(text => text.includes('Check') && text.includes('Input') && text.includes('Outcome')).length).toBeGreaterThanOrEqual(2);
    } finally { await task.destroy(); }
    await app.close();
    app = await electron.launch({ executablePath, env }); page = await app.firstWindow();
    await page.getByRole('button', { name: 'Analyze this IVP in detail', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save IVP_Solution.pdf', exact: true })).toBeVisible();
  } finally { await app.close(); server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); }
});
