import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangeRecord } from '../shared/types';
import { extractPdfText, makePdf } from './pdf';
import { ToolFailure } from './tool-outcome';
import { diagnosePatchMismatch } from './workspace-patch-diagnostics';
import { repositorySearch } from './repository-search';
import { readProjectRecord, patchProjectRecord, listProjectRecords, type RecordValue } from './project-records';

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
  async list(relative = '', limit = 200, signal?: AbortSignal): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('File limit must be a positive safe integer.');
    const target = await this.resolve(relative || '.');
    const files = await repositorySearch(await this.canonicalRoot(), path.relative(await this.canonicalRoot(), target) || '.', 'files', limit, undefined, signal);
    for (const file of files) await this.resolve(file);
    return files;
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
  async search(query: string, signal?: AbortSignal): Promise<string[]> {
    if (!query || query.length > 200) throw new Error('Search query must be 1–200 characters.');
    const results = await repositorySearch(await this.canonicalRoot(), '.', 'matches', 51, query, signal);
    for (const result of results) await this.resolve(result.split(/:\d+: /, 1)[0]);
    return results.length > 50 ? [...results.slice(0, 50), '[Search truncated after 50 matches; narrow the query.]'] : results;
  }
  async edit(relative: string, expectedHash: string | null, next: string, replacementIntent = false): Promise<ChangeRecord> {
    return this.writeText(relative, expectedHash, next, replacementIntent, MAX_FILE);
  }
  private async writeText(relative: string, expectedHash: string | null, next: string, replacementIntent: boolean, maximum: number): Promise<ChangeRecord> {
    if (path.extname(relative).toLowerCase() === '.pdf') throw new Error('Use create_pdf for PDFs; existing binary PDFs are never overwritten.');
    if (Buffer.byteLength(next) > maximum) throw new Error(`Edit exceeds the ${maximum} byte file limit.`);
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
  private async recordSource(relative: string) {
    if (!/\.[cm]?[jt]s$/i.test(relative)) throw new Error('Record tools support JavaScript and TypeScript catalogs only.');
    const filename = await this.resolve(relative);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Record source exceeds the 8 MiB limit.');
    const source = await fs.readFile(filename, 'utf8');
    if (source.includes('\0')) throw new Error('Binary files are not supported.');
    return source;
  }
  async readRecord(relative: string, variable: string, key: string) {
    const source = await this.recordSource(relative);
    return { fields: readProjectRecord(source, variable, key), hash: hash(source)! };
  }
  async listRecords(relative: string, variable: string, offset = 0, limit = 20) {
    const source = await this.recordSource(relative);
    return { ...listProjectRecords(source, variable, offset, limit), hash: hash(source)! };
  }
  async snapshotHash(relative: string): Promise<string> {
    return /\.[cm]?[jt]s$/i.test(relative) ? hash(await this.recordSource(relative))! : (await this.read(relative)).hash;
  }
  async patchRecord(relative: string, expectedHash: string, variable: string, key: string, fields: Record<string, RecordValue>) {
    const before = await this.recordSource(relative);
    if (hash(before) !== expectedHash) throw new ToolFailure('STALE_REVISION', `File changed since it was read: ${relative}`, { sourceRevision: hash(before), target: relative });
    return this.writeText(relative, expectedHash, patchProjectRecord(before, variable, key, fields), true, 8 * 1024 * 1024);
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
