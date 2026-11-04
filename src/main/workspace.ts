import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangeRecord } from '../shared/types';
import { extractPdfText, makePdf } from './pdf';
import { ToolFailure } from './tool-outcome';
import { diagnosePatchMismatch } from './workspace-patch-diagnostics';

const excluded = new Set(['.git', '.mercury', 'node_modules', 'dist', 'build', 'out', '.vite', '.next', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'venv']);
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
    const parts = relative.toLowerCase().split(/[\\/]+/);
    if (!relative || path.isAbsolute(relative) || parts.includes('..') || parts.includes('.git') || parts.some((part, index) => part === '.mercury' && parts[index + 1] === 'git')) throw new Error('Invalid workspace path. Git metadata is managed separately.');
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
    const skip = (name: string, rel: string) => excluded.has(name) || /^\.venv(?:[-_].*)?$/i.test(name) || patterns.some(pattern => {
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
  async read(relative: string, startLine = 1, endLine = startLine + 199) {
    const filename = await this.resolve(relative);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('File is not a readable file or exceeds 512 KB.');
    if (path.extname(filename).toLowerCase() === '.pdf') {
      const bytes = await fs.readFile(filename);
      const full = extractPdfText(bytes);
      const lines = full.split(/\r?\n/);
      const start = Math.max(1, Math.floor(startLine));
      const end = Math.min(lines.length, start + 199, Math.max(start, Math.floor(endLine)));
      return this.page(lines, start, end, hash(bytes.toString('base64'))!);
    }
    const full = await fs.readFile(filename, 'utf8');
    if (full.includes('\0')) throw new Error('Binary files are not supported.');
    const lines = full.split(/\r?\n/);
    const start = Math.max(1, Math.floor(startLine));
    const end = Math.min(lines.length, start + 199, Math.max(start, Math.floor(endLine)));
    return this.page(lines, start, end, hash(full)!);
  }
  private page(lines: string[], start: number, end: number, revision: string) {
    const selected: string[] = [];
    let characters = 0;
    for (let index = start - 1; index < end; index++) {
      const line = `${index + 1}: ${lines[index]}`;
      // Never silently cut a line and then claim the entire range was read.
      if (characters + line.length + 1 > 20000) {
        if (!selected.length) throw new Error(`Line ${start} exceeds the 20,000 character read limit. Use a bounded script to inspect this long line.`);
        break;
      }
      selected.push(line); characters += line.length + 1;
    }
    const last = start + selected.length - 1;
    return { content: selected.join('\n'), hash: revision, totalLines: lines.length, startLine: start,
      endLine: last, truncated: last < lines.length, nextStartLine: last < lines.length ? last + 1 : null };
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
  async edit(relative: string, expectedHash: string | null, next: string, replacementIntent = false): Promise<ChangeRecord> {
    if (path.extname(relative).toLowerCase() === '.pdf') throw new Error('Use create_pdf for PDFs; existing binary PDFs are never overwritten.');
    if (Buffer.byteLength(next) > MAX_FILE) throw new Error('Edit exceeds the 512 KB file limit.');
    const filename = await this.resolve(relative, true);
    const before = await fs.readFile(filename, 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return null; throw error; });
    if (expectedHash === null && before !== null)
      throw new ToolFailure('CREATE_TARGET_EXISTS', `File already exists: ${relative}. expectedHash:null (or omitted preconditions) is create-only. No file was changed or reverted. Read this file and pass its returned revision for an existing-file edit, or use patch_project_file.`, { sourceRevision: hash(before), target: relative });
    if (hash(before) !== expectedHash) throw new ToolFailure('STALE_REVISION', `File changed since it was read: ${relative}`, {sourceRevision:hash(before),target:relative});
    if (before !== null && next.length < before.length / 2 && !replacementIntent)
      throw new Error('Replacement would remove more than half of this file. Use patch_project_file for a partial edit, or set replacementIntent:true for a deliberate full rewrite.');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, next, { flag: 'wx' });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return { path: relative.replaceAll('\\', '/'), before, after: next, at: Date.now() };
  }
  async patch(relative: string, expectedHash: string, oldText: string, newText: string): Promise<ChangeRecord> {
    const before = await fs.readFile(await this.resolve(relative, true), 'utf8');
    if (hash(before) !== expectedHash) throw new ToolFailure('STALE_REVISION', `File changed since it was read: ${relative}`, {sourceRevision:hash(before),target:relative});
    // Reads present logical lines; match those across Windows/Unix line endings
    // while preserving every byte outside the targeted replacement.
    const logical = before.replaceAll('\r\n', '\n'), search = oldText.replaceAll('\r\n', '\n');
    const first = logical.indexOf(search);
    if (!search || first < 0 || logical.indexOf(search, first + 1) >= 0) {
      const diagnostic = search && first < 0 ? diagnosePatchMismatch(logical, search) : {};
      throw new ToolFailure('PATCH_NO_MATCH', first < 0
        ? 'Patch text matched no source region; the file still matches your read hash. No change was made. Copy exact source characters without changing quotes or doubling backslashes; prefer a small unique anchor.'
        : 'Patch text matched multiple source regions; it must match exactly one. Include enough unchanged surrounding text for one unique match.',
        { sourceRevision: hash(before), target: relative, ...diagnostic });
    }
    const rawIndex = (position: number) => {
      let raw = 0;
      for (let index = 0; index < position; index++, raw++) if (before[raw] === '\r' && before[raw + 1] === '\n') raw++;
      return raw;
    };
    const newline = before.includes('\r\n') ? '\r\n' : '\n';
    const replacement = newText.replaceAll('\r\n', '\n').replaceAll('\n', newline);
    return this.edit(relative, expectedHash, before.slice(0, rawIndex(first)) + replacement + before.slice(rawIndex(first + search.length)), true);
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
