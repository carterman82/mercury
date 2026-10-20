import path from 'node:path';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { imageSize } from 'image-size';
import { binaryInspection, boundedInspection, decodeText, inspectCompressedText, inspectZip, rtfText, xmlDocumentText, type FileInspection } from './file-inspection';
import type { ChatImage } from './vision';

const name = z.string().min(1).max(120);
const content = z.string().min(1).max(300_000);
const scalar = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);
export const documentSchema = z.object({ name, content });
export const spreadsheetSchema = z.object({ name, sheets: z.array(z.object({ name: z.string().min(1).max(31), rows: z.array(z.array(scalar).max(100)).min(1).max(5000) })).min(1).max(20) });
export const presentationSchema = z.object({ name, title: z.string().max(150), slides: z.array(z.object({ title: z.string().min(1).max(100), body: z.string().max(1200).optional(), bullets: z.array(z.string().max(180)).max(10).optional(), table: z.array(z.array(z.string().max(160)).max(6)).max(14).optional(), notes: z.string().max(4000).optional() })).min(1).max(60) });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coordinate = z.number().finite().min(-4096).max(8192);
const element = z.object({ type: z.enum(['rect', 'circle', 'line', 'text', 'path']), x: coordinate.optional(), y: coordinate.optional(), width: z.number().min(0).max(4096).optional(), height: z.number().min(0).max(4096).optional(), x2: coordinate.optional(), y2: coordinate.optional(), radius: z.number().min(0).max(2048).optional(), fill: color.optional(), stroke: color.optional(), strokeWidth: z.number().min(0).max(30).optional(), text: z.string().max(500).optional(), fontSize: z.number().min(6).max(180).optional(), d: z.string().max(10_000).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\seE]*$/).optional() });
export const graphicSchema = z.object({ name, width: z.number().int().min(16).max(2048), height: z.number().int().min(16).max(2048), background: color.optional(), elements: z.array(element).min(1).max(1000) });
export const archiveSchema = z.object({ name, files: z.array(z.object({ name: z.string().min(1).max(200), content: z.string().max(300_000).optional(), fileId: z.string().uuid().optional() })).min(1).max(100) });
export interface GeneratedFile { bytes: Buffer; text: string; format: string; note?: string; }

type MarkdownNode = { type: string; value?: string; depth?: number; ordered?: boolean; children?: MarkdownNode[] };
const escapeXml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));

export function graphicSvg(input: z.infer<typeof graphicSchema>): string {
  const shapes = input.elements.map(shape => {
    const paint = `fill="${shape.fill ?? (shape.type === 'line' || shape.type === 'path' ? 'none' : '#243245')}" stroke="${shape.stroke ?? 'none'}" stroke-width="${shape.strokeWidth ?? 2}"`;
    if (shape.type === 'rect') return `<rect x="${shape.x ?? 0}" y="${shape.y ?? 0}" width="${shape.width ?? 100}" height="${shape.height ?? 60}" rx="4" ${paint}/>`;
    if (shape.type === 'circle') return `<circle cx="${shape.x ?? 0}" cy="${shape.y ?? 0}" r="${shape.radius ?? 30}" ${paint}/>`;
    if (shape.type === 'line') return `<line x1="${shape.x ?? 0}" y1="${shape.y ?? 0}" x2="${shape.x2 ?? 100}" y2="${shape.y2 ?? 100}" stroke="${shape.stroke ?? '#243245'}" stroke-width="${shape.strokeWidth ?? 2}"/>`;
    if (shape.type === 'path') return `<path d="${shape.d ?? ''}" ${paint}/>`;
    return `<text x="${shape.x ?? 0}" y="${shape.y ?? 24}" font-family="Arial,sans-serif" font-size="${shape.fontSize ?? 24}" ${paint}>${escapeXml(shape.text ?? '')}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}"><rect width="100%" height="100%" fill="${input.background ?? '#ffffff'}"/>${shapes.join('')}</svg>`;
}

export class FileFormats {
  private require: NodeJS.Require;
  private nativeRequire: NodeJS.Require;
  private ocrQueue: Promise<unknown> = Promise.resolve();
  constructor(private runtime: string, nativeRuntime = runtime) {
    this.require = createRequire(path.join(runtime, 'package.json'));
    this.nativeRequire = createRequire(path.join(nativeRuntime, 'package.json'));
  }
  async visionImage(bytes: Buffer): Promise<ChatImage | null> {
    // Detect raster content, not a filename supplied by the user. Never render SVG/HTML here.
    let dimensions;
    try { dimensions = imageSize(bytes); } catch { return null; }
    if (!dimensions.width || !dimensions.height || !['png', 'jpg', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'avif'].includes(dimensions.type ?? '') || dimensions.width * dimensions.height > 20_000_000) return null;
    if (['png', 'jpg', 'webp'].includes(dimensions.type!) && bytes.length <= 4 * 1024 * 1024 && Math.max(dimensions.width, dimensions.height) <= 2048) {
      return { mimeType: dimensions.type === 'jpg' ? 'image/jpeg' : dimensions.type === 'webp' ? 'image/webp' : 'image/png', data: bytes.toString('base64') };
    }
    const { loadImage, createCanvas } = this.nativeRequire('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
    const image = await loadImage(bytes);
    const scale = Math.min(1, 2048 / Math.max(dimensions.width, dimensions.height));
    const canvas = createCanvas(Math.max(1, Math.round(dimensions.width * scale)), Math.max(1, Math.round(dimensions.height * scale)));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { mimeType: 'image/jpeg', data: canvas.toBuffer('image/jpeg', 85).toString('base64') };
  }
  async ocr(bytes: Buffer): Promise<string> {
    const run = this.ocrQueue.then(async () => {
      const { createWorker } = this.require('tesseract.js') as typeof import('tesseract.js');
      const language = path.join(path.dirname(this.require.resolve('@tesseract.js-data/eng')), '4.0.0');
      await fs.access(path.join(language, 'eng.traineddata.gz'));
      let timedOut = false;
      let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; void worker?.terminate(); reject(new Error('Local OCR exceeded its 45-second limit.')); }, 45_000); });
      try {
        const work = (async () => {
          worker = await createWorker('eng', 1, { langPath: language, cacheMethod: 'none', gzip: true, errorHandler: () => {} });
          if (timedOut) { await worker.terminate(); throw new Error('OCR timed out.'); }
          const result = await worker.recognize(bytes);
          return result.data.text.trim();
        })();
        return await Promise.race([work, timeout]);
      } finally { clearTimeout(timer!); if (worker && !timedOut) await worker.terminate(); }
    });
    this.ocrQueue = run.catch(() => {});
    return run;
  }
  async inspect(name: string, bytes: Buffer): Promise<FileInspection> {
    const ext = path.extname(name).toLowerCase();
    try {
      if (['.docx', '.pptx', '.xlsx', '.xlsm', '.odt', '.ods', '.odp', '.epub', '.zip'].includes(ext) || bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
        if (ext === '.zip' || !['.docx', '.pptx', '.xlsx', '.xlsm', '.odt', '.ods', '.odp', '.epub'].includes(ext)) {
          const { entries } = inspectZip(bytes, false);
          return { format: 'ZIP archive', readStatus: 'partial', note: 'Archive member names and sizes only; members were not executed or extracted.', text: entries.map(entry => `${entry.name} (${entry.size} bytes)`).join('\n') };
        }
        const { files } = inspectZip(bytes, true);
        if (ext === '.xlsx' || ext === '.xlsm') return await this.inspectWorkbook(bytes);
        const selected = Object.keys(files).filter(filename => ext === '.docx' ? /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(filename) : ext === '.pptx' ? /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(filename) : filename === 'content.xml').sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        let text = selected.map(filename => `[${filename}]\n${xmlDocumentText(files[filename])}`).join('\n\n');
        if (ext === '.epub') {
          // EPUB reading order is best-effort; no external resources are loaded.
          const all = inspectZip(bytes, false).entries.filter(entry => /\.(xhtml|html|htm)$/i.test(entry.name));
          const epubFiles = this.unzipHtml(bytes);
          text = all.map(entry => `[${entry.name}]\n${xmlDocumentText(epubFiles[entry.name])}`).join('\n\n');
        }
        if (!text.trim()) throw new Error('No readable document text was found.');
        return boundedInspection({ format: ext.slice(1).toUpperCase(), readStatus: 'partial', note: 'Document text and tables extracted. Embedded images, exact visual layout, and macros were not interpreted or executed.', text });
      }
      if (['.gz', '.tgz', '.tar'].includes(ext) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) return boundedInspection(inspectCompressedText(name, bytes));
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.avif'].includes(ext)) {
        const dimensions = imageSize(bytes);
        if (!dimensions?.width || !dimensions.height) throw new Error('Image dimensions could not be identified.');
        if (dimensions.width * dimensions.height > 20_000_000) throw new Error('Image exceeds the 20-megapixel OCR limit.');
        let raster = bytes;
        if (!['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'].includes(ext)) {
          const { loadImage, createCanvas } = this.nativeRequire('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
          const image = await loadImage(bytes);
          const canvas = createCanvas(dimensions.width, dimensions.height);
          canvas.getContext('2d').drawImage(image, 0, 0); raster = canvas.toBuffer('image/png');
        }
        let text = '', error = '';
        try { text = await this.ocr(raster); } catch (problem) { error = String(problem); }
        return boundedInspection({ format: ext.slice(1).toUpperCase() + ' image', readStatus: text ? 'partial' : 'metadata', note: text ? 'English OCR text only; recognition may contain errors. Visual objects, charts, and scenes have not been interpreted. Only the first frame/page is considered.' : `Image metadata only. ${error || 'No readable text was found by local English OCR.'} Visual contents have not been interpreted.`, text: `Image: ${name}\nDimensions: ${dimensions.width} × ${dimensions.height}\n${text ? 'Local OCR text:\n' + text : 'No image text could be extracted.'}` });
      }
      const knownText = /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|xml|html?|css|js|jsx|ts|tsx|py|java|c|cpp|h|cs|rs|go|rb|php|sh|ps1|bat|sql|yaml|yml|toml|ini|cfg|log|tex|svg|rtf|eml|srt|vtt|ics)$/i.test(name);
      const decoded = decodeText(bytes, knownText);
      if (decoded) return boundedInspection({ format: ext === '.rtf' ? 'RTF' : `Text (${decoded.encoding})`, readStatus: decoded.encoding === 'windows-1252' || ext === '.rtf' ? 'partial' : 'readable', note: decoded.encoding === 'windows-1252' ? 'Encoding was inferred as Windows-1252; some characters may differ.' : ext === '.rtf' ? 'RTF text extracted; formatting and embedded objects are not represented.' : undefined, text: ext === '.rtf' ? rtfText(decoded.text) : decoded.text });
      return binaryInspection(name, bytes);
    } catch (error) {
      return binaryInspection(name, bytes, `Content extraction was unavailable: ${error instanceof Error ? error.message : String(error)} Only metadata and a binary preview were inspected.`);
    }
  }
  private unzipHtml(bytes: Buffer): Record<string, Uint8Array> {
    let total = 0;
    return unzipSync(bytes, { filter: file => { total += file.originalSize; if (total > 32 * 1024 * 1024) throw new Error('EPUB expansion limit exceeded.'); return /\.(xhtml|html|htm)$/i.test(file.name); } });
  }
  private async inspectWorkbook(bytes: Buffer): Promise<FileInspection> {
    const Excel = this.require('exceljs') as typeof import('exceljs');
    const workbook = new Excel.Workbook();
    await workbook.xlsx.load(bytes as any);
    let count = 0, truncated = false;
    const output: string[] = [];
    workbook.eachSheet(sheet => {
      output.push(`\n[Sheet: ${sheet.name}; rows: ${sheet.rowCount}; columns: ${sheet.columnCount}]`);
      sheet.eachRow((row, rowNumber) => {
        if (count >= 25_000) { truncated = true; return; }
        const cells: string[] = [];
        row.eachCell((cell, column) => {
          if (++count > 25_000) { truncated = true; return; }
          const value: any = cell.value;
          const text = value?.formula ? `=${value.formula} [cached result: ${value.result ?? 'not available'}]` : value?.richText ? value.richText.map((run: any) => run.text).join('') : value?.hyperlink ? `${value.text} (${value.hyperlink})` : value?.error ? value.error : value instanceof Date ? value.toISOString() : String(value ?? '');
          cells.push(`${column}: ${text}`);
        });
        output.push(`Row ${rowNumber}: ${cells.join(' | ')}`);
      });
    });
    return boundedInspection({ format: 'Excel workbook', readStatus: 'partial', note: `Cells, formulas, and saved formula results extracted; charts/images/macros were not interpreted or executed. Formulas were not recalculated.${truncated ? ' Extraction stopped at 25,000 cells.' : ''}`, text: output.join('\n') });
  }
  async document(raw: unknown): Promise<GeneratedFile> {
    const input = documentSchema.parse(raw);
    const docx = this.require('docx') as typeof import('docx');
    const { Document, Paragraph, TextRun, Packer, Table, TableCell, TableRow, HeadingLevel, WidthType } = docx;
    const tree = unified().use(remarkParse).use(remarkGfm).parse(input.content) as MarkdownNode;
    const plain = (node: MarkdownNode): string => node.value ?? node.children?.map(plain).join('') ?? '';
    const runs = (nodes: MarkdownNode[], style: Record<string, unknown> = {}): InstanceType<typeof TextRun>[] => nodes.flatMap(node => {
      if (node.type === 'strong') return runs(node.children ?? [], { ...style, bold: true });
      if (node.type === 'emphasis') return runs(node.children ?? [], { ...style, italics: true });
      if (node.type === 'break') return [new TextRun({ break: 1 })];
      if (node.children) return runs(node.children, style);
      return [new TextRun({ text: plain(node), ...(node.type === 'inlineCode' ? { font: 'Consolas', color: '216080' } : {}), ...style })];
    });
    const blocks = (nodes: MarkdownNode[]): (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] => nodes.flatMap((node): any[] => {
      if (node.type === 'table') return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: (node.children ?? []).map((row, index) => new TableRow({ tableHeader: index === 0, children: (row.children ?? []).map(cell => new TableCell({ shading: index === 0 ? { fill: 'E7F0F6' } : undefined, children: [new Paragraph({ children: runs(cell.children ?? [], index === 0 ? { bold: true } : {}) })] })) })) })];
      if (node.type === 'list') return (node.children ?? []).flatMap((item, index) => [new Paragraph({ children: [new TextRun(`${node.ordered ? index + 1 + '.' : '•'} `), ...runs(item.children?.flatMap(child => child.children ?? [child]) ?? [])], spacing: { after: 100 } })]);
      if (node.type === 'code') return (node.value ?? '').split('\n').map(line => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })], shading: { fill: 'F2F5F8' }, spacing: { after: 0 } }));
      if (node.type === 'blockquote') return blocks(node.children ?? []);
      if (node.type === 'thematicBreak') return [new Paragraph({ text: '────────────────────────────────────' })];
      const headings = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
      return [new Paragraph({ children: runs(node.children ?? [node]), heading: node.type === 'heading' ? headings[Math.min((node.depth ?? 1) - 1, 3)] : undefined, keepNext: node.type === 'heading', spacing: { after: 160 } })];
    });
    const document = new Document({ creator: 'Mercury', title: input.name, styles: { default: { document: { run: { font: 'Calibri', size: 22, color: '243245' }, paragraph: { spacing: { line: 300 } } } } }, sections: [{ properties: { page: { margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } }, children: blocks(tree.children ?? []) }] });
    return { bytes: await Packer.toBuffer(document), text: input.content, format: 'Word document' };
  }
  async spreadsheet(raw: unknown): Promise<GeneratedFile> {
    const input = spreadsheetSchema.parse(raw);
    const Excel = this.require('exceljs') as typeof import('exceljs');
    const workbook = new Excel.Workbook(); workbook.creator = 'Mercury';
    for (const data of input.sheets) {
      if (/[\\/?*\[\]:]/.test(data.name) || workbook.getWorksheet(data.name)) throw new Error('Sheet names must be unique and cannot contain \\ / ? * [ ] :');
      const sheet = workbook.addWorksheet(data.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      sheet.addRows(data.rows);
      const header = sheet.getRow(1); header.font = { bold: true, color: { argb: 'FF142B42' } }; header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F0F6' } }; header.height = 24;
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.rows.length, column: Math.max(...data.rows.map(row => row.length), 1) } };
      sheet.columns.forEach(column => { column.width = Math.min(50, Math.max(14, ...data.rows.slice(0, 100).map(row => String(row[column.number! - 1] ?? '').length + 2))); column.alignment = { vertical: 'top', wrapText: true }; });
    }
    return { bytes: Buffer.from(await workbook.xlsx.writeBuffer()), text: input.sheets.map(sheet => `[${sheet.name}]\n${sheet.rows.map(row => row.join('\t')).join('\n')}`).join('\n\n'), format: 'Excel workbook' };
  }
  async presentation(raw: unknown): Promise<GeneratedFile> {
    const input = presentationSchema.parse(raw);
    const Pptx = this.require('pptxgenjs') as typeof import('pptxgenjs').default;
    const deck = new Pptx(); deck.layout = 'LAYOUT_WIDE'; deck.author = 'Mercury'; deck.title = input.title;
    // Split large tables before layout so every continuation keeps its title/header.
    const slides = input.slides.flatMap(data => {
      if (!data.table?.length) return [data];
      if (data.bullets?.length) throw new Error('Use separate slides for bullet lists and tables.');
      const columns = Math.max(...data.table.map(row => row.length), 1);
      const charsPerLine = Math.max(10, Math.floor((11.9 / columns * 72 - 12) / 7));
      const rowHeight = (row: string[]) => .17 + Math.max(...row.map(cell => Math.ceil(Math.max(1, cell.length) / charsPerLine)), 1) * .23;
      const header = data.table[0];
      const pages: typeof input.slides = [];
      let table = [header], used = rowHeight(header), first = true;
      for (const row of data.table.slice(1)) {
        const height = rowHeight(row);
        const available = first && data.body ? 3.2 : 4.8;
        if (used + height > available && table.length > 1) { pages.push({ ...data, title: first ? data.title : `${data.title} (continued)`, body: first ? data.body : undefined, table }); first = false; table = [header]; used = rowHeight(header); }
        table.push(row); used += height;
      }
      pages.push({ ...data, title: first ? data.title : `${data.title} (continued)`, body: first ? data.body : undefined, table });
      return pages;
    });
    for (const [index, data] of slides.entries()) {
      const slide = deck.addSlide(); slide.background = { color: 'F8FAFC' };
      slide.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: .16, fill: { color: '287E9A' }, line: { color: '287E9A' } });
      slide.addText(data.title, { x: .65, y: .4, w: 12, h: .9, fontFace: 'Aptos Display', fontSize: 30, bold: true, color: '142B42', margin: 0, breakLine: false, fit: 'shrink' });
      let y = 1.5;
      if (data.body) { const height = data.table?.length || data.bullets?.length ? 1.5 : 4.8; slide.addText(data.body, { x: .7, y, w: 11.9, h: height, fontFace: 'Aptos', fontSize: 21, color: '243245', valign: 'top', margin: 0, fit: 'shrink' }); y += height + .15; }
      if (data.bullets?.length) {
        if (data.table?.length) throw new Error('Use separate slides for bullet lists and tables to avoid cramped content.');
        slide.addText(data.bullets.map(text => ({ text, options: { bullet: { indent: 20 }, breakLine: true } })), { x: .8, y, w: 11.7, h: 6.5 - y, fontFace: 'Aptos', fontSize: 22, color: '243245', margin: 0, paraSpaceAfter: 14, fit: 'shrink' });
      }
      if (data.table?.length) slide.addTable(data.table.map((row, index) => row.map(text => ({ text, options: { bold: index === 0, fill: { color: index === 0 ? 'E7F0F6' : 'FFFFFF' } } }))), { x: .7, y, w: 11.9, fontFace: 'Aptos', fontSize: 13, color: '243245', border: { type: 'solid', color: 'D3DFE8', pt: 1 }, fill: { color: 'EDF4F8' }, margin: 6, autoPage: false });
      slide.addText(`${input.title}  •  ${index + 1}`, { x: .7, y: 7.05, w: 12, h: .2, fontSize: 10, color: '65768A', margin: 0 });
      if (data.notes) slide.addNotes(data.notes);
    }
    return { bytes: Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer), text: input.slides.map((slide, index) => `Slide ${index + 1}: ${slide.title}\n${slide.body ?? ''}\n${slide.bullets?.join('\n') ?? ''}\n${slide.table?.map(row => row.join(' | ')).join('\n') ?? ''}\n${slide.notes ?? ''}`).join('\n\n'), format: 'PowerPoint presentation' };
  }
  async graphic(raw: unknown): Promise<GeneratedFile> {
    const input = graphicSchema.parse(raw);
    const svg = graphicSvg(input);
    if (input.name.toLowerCase().endsWith('.svg')) return { bytes: Buffer.from(svg), text: svg, format: 'SVG graphic' };
    const { createCanvas, loadImage } = this.nativeRequire('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
    const canvas = createCanvas(input.width, input.height);
    canvas.getContext('2d').drawImage(await loadImage(Buffer.from(svg)), 0, 0);
    const jpeg = /\.jpe?g$/i.test(input.name);
    return { bytes: jpeg ? canvas.toBuffer('image/jpeg') : canvas.toBuffer('image/png'), text: `Programmatic graphic ${input.width} × ${input.height}\n${JSON.stringify(input.elements)}`, format: jpeg ? 'JPEG graphic' : 'PNG graphic', note: 'Generated from drawing instructions without an image-generation model.' };
  }
  archive(raw: unknown, sources: Map<string, Buffer>): GeneratedFile {
    const input = archiveSchema.parse(raw);
    const entries: Record<string, Uint8Array> = {};
    let total = 0;
    for (const item of input.files) {
      if (/^[\\/]|[<>:"|?*\x00-\x1f]/.test(item.name) || item.name.split(/[\\/]/).some(part => !part || part === '..' || part === '.' || /[. ]$/.test(part))) throw new Error('Archive entries must use safe relative paths.');
      if ((item.fileId === undefined) === (item.content === undefined)) throw new Error('Each archive entry needs exactly one of content or fileId.');
      const bytes = item.fileId ? sources.get(item.fileId) : strToU8(item.content!);
      if (!bytes) throw new Error('Archive source file is not available in this conversation.');
      const entry = item.name.replaceAll('\\', '/');
      if (Object.hasOwn(entries, entry)) throw new Error('Archive entry names must be unique.');
      total += bytes.length; if (total > 25 * 1024 * 1024) throw new Error('Archive content exceeds 25 MB.');
      Object.defineProperty(entries, entry, { value: bytes, enumerable: true });
    }
    return { bytes: Buffer.from(zipSync(entries)), text: input.files.map(file => file.name).join('\n'), format: 'ZIP archive', note: 'Archive created from the listed conversation files or supplied text.' };
  }
}
