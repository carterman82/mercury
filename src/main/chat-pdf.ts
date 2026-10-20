import { BrowserWindow } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfDocumentHtml } from './pdf-document';
import { createRequire } from 'node:module';

export async function previewChatPdf(bytes: Buffer, runtime: string, requestedPage: number) {
  const load = new Function('url', 'return import(url)') as (url: string) => Promise<typeof import('pdfjs-dist')>;
  const pdfjs = await load(pathToFileURL(path.join(runtime, 'legacy', 'build', 'pdf.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(runtime, 'legacy', 'build', 'pdf.worker.mjs')).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const pageNumber = Math.min(requestedPage, pdf.numPages);
    const page = await pdf.getPage(pageNumber);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 1400 / natural.width, Math.sqrt(3_000_000 / (natural.width * natural.height)));
    const viewport = page.getViewport({ scale });
    const { createCanvas } = createRequire(path.join(runtime, 'package.json'))('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
    return { kind: 'pdf' as const, image: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`, page: pageNumber, pages: pdf.numPages };
  } finally { await task.destroy(); }
}

export async function renderChatPdf(content: string): Promise<Buffer> {
  // The only script executed is our font-readiness check below. The generated
  // document's strict CSP blocks all document scripts; model HTML is sanitized.
  const document = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  document.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    const { html } = pdfDocumentHtml(content);
    await document.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Wait for embedded math fonts and final layout before printing.
    await document.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true);
    return await document.webContents.printToPDF({
      printBackground: true, pageSize: 'Letter', preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;padding:0 17mm;font:8px Arial;color:#697887;display:flex;justify-content:space-between"><span>Mercury</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
  } finally { document.destroy(); }
}

export async function readChatPdf(bytes: Buffer, runtime: string, ocr?: (image: Buffer) => Promise<string>): Promise<string> {
  // Keep PDF.js and its worker as modules in resources, outside the Vite bundle.
  const load = new Function('url', 'return import(url)') as (url: string) => Promise<typeof import('pdfjs-dist')>;
  const pdfjs = await load(pathToFileURL(path.join(runtime, 'legacy', 'build', 'pdf.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(runtime, 'legacy', 'build', 'pdf.worker.mjs')).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    let total = 0;
    let scanned = 0;
    for (let index = 1; index <= Math.min(pdf.numPages, 200); index++) {
      const page = await pdf.getPage(index);
      const text = await page.getTextContent();
      let content = text.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      if (!content.trim() && ocr && scanned++ < 10) {
        try {
          const { createCanvas } = createRequire(path.join(runtime, 'package.json'))('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
          const viewport = page.getViewport({ scale: 1.5 });
          if (viewport.width * viewport.height > 8_000_000) throw new Error('Page exceeds the OCR pixel limit.');
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
          content = '[Local English OCR; may contain recognition errors]\n' + (await ocr(canvas.toBuffer('image/png')) || '[No readable text found]');
        } catch (error) { content = `[Page OCR unavailable: ${String(error).slice(0, 200)}]`; }
      } else if (!content.trim()) content = '[Image-only page; content not read. OCR is limited to 10 image-only pages.]';
      total += content.length;
      if (total > 300_000) throw new Error('PDF text exceeds 300,000 characters. Attach a smaller document.');
      pages.push(`[Page ${index}]\n${content}`);
      page.cleanup();
    }
    if (pdf.numPages > 200) pages.push(`[Only the first 200 of ${pdf.numPages} pages were inspected.]`);
    if (!pages.some(page => page.replace(/^\[Page \d+\]/, '').trim())) throw new Error('This PDF has no selectable text. Scanned documents require OCR.');
    return pages.join('\n\n');
  } finally { await task.destroy(); }
}
