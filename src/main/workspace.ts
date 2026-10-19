import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangeRecord } from '../shared/types';
import { extractPdfText, makePdf } from './pdf';

const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.vite', '.next', 'coverage']);
const MAX_FILE = 512_000;

export function hash(content: string | null): string | null {
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}

export class Workspace {
  private rootReal: string | null = null;
  constructor(readonly root: string) {}
  private async canonicalRoot(): Promise<string> { return this.rootReal ??= await fs.realpath(this.root); }
  private within(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }
  async resolve(relative: string, write = false): Promise<string> {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..') || relative.split(/[\\/]+/).includes('.git')) throw new Error('Invalid workspace path.');
    const root = await this.canonicalRoot();
    const target = path.resolve(root, relative);
    if (!this.within(root, target)) throw new Error('Path escapes the project.');
    let existing = target;
    while (true) {
      try { await fs.lstat(existing); break; }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error('Invalid workspace path.');
        existing = parent;
      }
    }
    const real = await fs.realpath(existing);
    if (!this.within(root, real)) throw new Error('Path follows a link outside the project.');
    if (write && existing === target) {
      const stat = await fs.lstat(target);
      if (!stat.isFile()) throw new Error('Can only edit regular files.');
    }
    return target;
  }
  async list(relative = '', limit = 200): Promise<string[]> {
    const output: string[] = [];
    const ignore = await fs.readFile(path.join(this.root, '.gitignore'), 'utf8').catch(() => '');
    const patterns = ignore.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#') && !x.startsWith('!'));
    const skip = (name: string, rel: string) => excluded.has(name) || patterns.some(pattern => {
      const p = pattern.replace(/\/$/, '');
      return p === name || p === rel || (p.startsWith('*.') && name.endsWith(p.slice(1)));
    });
    const walk = async (dir: string, depth: number) => {
      if (depth > 8 || output.length >= limit) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (output.length >= limit) break;
        const absolute = path.join(dir, entry.name);
        const rel = path.relative(this.root, absolute).replaceAll('\\', '/');
        if (skip(entry.name, rel) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(absolute, depth + 1);
        else if (entry.isFile()) output.push(rel);
      }
    };
    await walk(await this.resolve(relative || '.'), 0);
    return output;
  }
  async read(relative: string, startLine = 1, endLine = 200): Promise<{ content: string; hash: string }> {
    const filename = await this.resolve(relative);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('File is not a readable file or exceeds 512 KB.');
    if (path.extname(filename).toLowerCase() === '.pdf') {
      const bytes = await fs.readFile(filename);
      const full = extractPdfText(bytes);
      const lines = full.split(/\r?\n/);
      const start = Math.max(1, Math.floor(startLine));
      const end = Math.min(lines.length, start + 199, Math.max(start, Math.floor(endLine)));
      return { content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 20_000), hash: hash(bytes.toString('base64'))! };
    }
    const full = await fs.readFile(filename, 'utf8');
    if (full.includes('\0')) throw new Error('Binary files are not supported.');
    const lines = full.split(/\r?\n/);
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.min(lines.length, start + 199, Math.max(start, Math.floor(endLine)));
    return { content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n').slice(0, 20_000), hash: hash(full)! };
  }
  async search(query: string): Promise<string[]> {
    if (!query || query.length > 200) throw new Error('Search query must be 1–200 characters.');
    const results: string[] = [];
    for (const relative of await this.list('', 300)) {
      if (results.length >= 50) break;
      try {
        const filename = await this.resolve(relative);
        if ((await fs.stat(filename)).size > MAX_FILE) continue;
        const lines = (await fs.readFile(filename, 'utf8')).split(/\r?\n/);
        lines.forEach((line, index) => { if (results.length < 50 && line.toLowerCase().includes(query.toLowerCase())) results.push(`${relative}:${index + 1}: ${line.slice(0, 240)}`); });
      } catch { /* Unreadable files are skipped. */ }
    }
    return results;
  }
  async edit(relative: string, expectedHash: string | null, next: string): Promise<ChangeRecord> {
    if (path.extname(relative).toLowerCase() === '.pdf') throw new Error('Use create_pdf for PDFs; existing binary PDFs are never overwritten.');
    if (Buffer.byteLength(next) > MAX_FILE) throw new Error('Edit exceeds the 512 KB file limit.');
    const filename = await this.resolve(relative, true);
    const before = await fs.readFile(filename, 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    if (hash(before) !== expectedHash) throw new Error(`File changed since it was read: ${relative}`);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, next, { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return { path: relative.replaceAll('\\', '/'), before, after: next, at: Date.now() };
  }
  async createPdf(relative: string, content: string): Promise<ChangeRecord> {
    if (path.extname(relative).toLowerCase() !== '.pdf') throw new Error('PDF files must use the .pdf extension.');
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('PDF source text exceeds the 512 KB limit.');
    const filename = await this.resolve(relative);
    const before = await fs.readFile(filename).then(bytes => `[binary PDF: ${bytes.length} bytes]`, (error: any) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (before !== null) throw new Error(`PDF already exists: ${relative}`);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, makePdf(content), { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return { path: relative.replaceAll('\\', '/'), before: null, after: `[binary PDF created from ${content.length} characters]`, at: Date.now() };
  }
}
