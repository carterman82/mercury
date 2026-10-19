import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatFile } from '../shared/types';
import { FileFormats, archiveSchema } from './file-formats';
import { binaryInspection, boundedInspection, type FileInspection } from './file-inspection';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 300_000;
export class ChatFiles {
  constructor(private root: string, private renderPdf: (content: string) => Promise<Buffer>, private readPdf: (bytes: Buffer) => Promise<string>, private formats = new FileFormats(process.cwd())) {}
  private filename(id: string, suffix: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error('Invalid file ID.');
    return path.join(this.root, id + suffix);
  }
  async get(id: string): Promise<ChatFile> { return JSON.parse(await fs.readFile(this.filename(id, '.json'), 'utf8')); }
  async bytes(id: string): Promise<Buffer> { await this.get(id); return fs.readFile(this.filename(id, '.bin')); }
  async text(id: string): Promise<string> { await this.get(id); return fs.readFile(this.filename(id, '.txt'), 'utf8'); }
  private async store(name: string, bytes: Buffer, text: string, kind: ChatFile['kind'], info: Partial<Pick<ChatFile, 'format' | 'readStatus' | 'note'>> = {}): Promise<ChatFile> {
    if (text.length > MAX_TEXT) throw new Error('Extracted file text exceeds 300,000 characters. Attach a smaller document.');
    if (bytes.length > MAX_BYTES) throw new Error('File exceeds the 25 MB limit.');
    await fs.mkdir(this.root, { recursive: true });
    const file: ChatFile = { id: randomUUID(), name, size: bytes.length, kind, ...info };
    await fs.writeFile(this.filename(file.id, '.bin'), bytes, { flag: 'wx' });
    await fs.writeFile(this.filename(file.id, '.txt'), text, { flag: 'wx' });
    await fs.writeFile(this.filename(file.id, '.json'), JSON.stringify(file), { flag: 'wx' });
    return file;
  }
  async import(filename: string): Promise<ChatFile> {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Drop regular files up to 25 MB each. Folders are not supported.');
    const bytes = await fs.readFile(filename);
    if (bytes.length > MAX_BYTES) throw new Error('File exceeds 25 MB.');
    const name = path.basename(filename);
    let info: FileInspection;
    if (path.extname(filename).toLowerCase() === '.pdf' || bytes.subarray(0, 5).toString() === '%PDF-') {
      try { info = boundedInspection({ text: await this.readPdf(bytes), format: 'PDF', readStatus: 'partial', note: 'Extracted document text; layout and visual objects are not represented. Local English OCR is used for image-only pages when available and may contain errors.' }); }
      catch (error) { info = binaryInspection(name, bytes, `PDF text could not be extracted: ${String(error).slice(0, 350)}. Contents have not been fully read.`); }
    } else info = await this.formats.inspect(name, bytes);
    const { text, ...metadata } = info;
    return this.store(name, bytes, text, 'upload', metadata);
  }
  private validateName(name: string): void {
    if (!name || name === '.' || name === '..' || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error('Use a simple filename without directory separators or reserved device names.');
  }
  async create(name: string, content: string, pdf: boolean): Promise<ChatFile> {
    this.validateName(name);
    if (pdf !== name.toLowerCase().endsWith('.pdf')) throw new Error('Use create_pdf for .pdf files and create_file for text files.');
    if (!pdf && /\.(docx?|xlsx?|xlsm|pptx?|png|jpe?g|gif|webp|bmp|tiff?|ico|zip|7z|rar|exe|dll|mp[34]|wav)$/i.test(name)) throw new Error('Use a dedicated document, spreadsheet, presentation, graphic, or archive tool for binary formats. Renaming UTF-8 text does not create a valid binary file.');
    if (!content.trim() || content.length > MAX_TEXT) throw new Error('File content must contain 1–300,000 characters.');
    if (/\.json$/i.test(name)) JSON.parse(content);
    if (/\.rtf$/i.test(name) && !content.startsWith('{\\rtf')) throw new Error('RTF content must be a complete RTF document starting with {\\rtf. Use create_document for formatted Word documents.');
    return this.store(name, pdf ? await this.renderPdf(content) : Buffer.from(content, 'utf8'), content, 'generated', { format: pdf ? 'PDF' : path.extname(name).slice(1).toUpperCase() || 'Text', readStatus: 'readable' });
  }
  async createStandard(tool: string, raw: unknown, allowed: Set<string>): Promise<ChatFile> {
    const name = (raw as any)?.name;
    if (typeof name !== 'string') throw new Error('A filename is required.');
    this.validateName(name);
    if (JSON.stringify(raw).length > 500_000) throw new Error('File specification exceeds 500,000 characters.');
    const extensions: Record<string, RegExp> = { create_document: /\.docx$/i, create_spreadsheet: /\.xlsx$/i, create_presentation: /\.pptx$/i, create_graphic: /\.(svg|png|jpe?g)$/i, create_archive: /\.zip$/i };
    if (!extensions[tool]?.test(name)) throw new Error(`Filename extension does not match ${tool}. Use DOCX, XLSX, PPTX, SVG/PNG/JPEG, or ZIP respectively.`);
    let result;
    if (tool === 'create_document') result = await this.formats.document(raw);
    else if (tool === 'create_spreadsheet') result = await this.formats.spreadsheet(raw);
    else if (tool === 'create_presentation') result = await this.formats.presentation(raw);
    else if (tool === 'create_graphic') result = await this.formats.graphic(raw);
    else {
      const archive = archiveSchema.parse(raw);
      const sources = new Map<string, Buffer>();
      let sourceSize = 0;
      for (const file of archive.files) if (file.fileId) {
        if (!allowed.has(file.fileId)) throw new Error('Archive source is not attached to this conversation.');
        sourceSize += (await this.get(file.fileId)).size;
        if (sourceSize > MAX_BYTES) throw new Error('Archive source data exceeds 25 MB.');
        sources.set(file.fileId, await this.bytes(file.fileId));
      }
      result = this.formats.archive(raw, sources);
    }
    const preview = boundedInspection({ text: result.text, format: result.format, readStatus: 'readable', note: result.note });
    return this.store(name, result.bytes, preview.text, 'generated', { format: preview.format, readStatus: preview.readStatus, note: preview.note });
  }
}
