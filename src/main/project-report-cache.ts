import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectReport } from '../shared/types';

export interface DiagramAnalysis { path: string; hash: string; notes: string[]; }
export interface ReportReduction { hash: string; summary: string; }
export const diagramHash = (content: string) => createHash('sha256').update(content).digest('hex');
const schema = z.object({
  version: z.literal(1), root: z.string(),
  report: z.object({ content: z.string(), diagram: z.string(), sources: z.number(), generatedAt: z.string(), lastCommit: z.string().nullable() }),
  analyses: z.array(z.object({ path: z.string(), hash: z.string(), notes: z.array(z.string()) })),
  reductions: z.array(z.object({ hash: z.string(), summary: z.string() })).default([]),
});
export interface ReportCache { version: 1; root: string; report: ProjectReport; analyses: DiagramAnalysis[]; reductions: ReportReduction[]; }

/** Reports live in app data, outside the user's Git checkout. */
export class ProjectReportCache {
  private active = new Map<string, Promise<ProjectReport>>();
  constructor(private directory: string) {}
  private key(root: string) { return process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root); }
  private filename(root: string) { return path.join(this.directory, `${diagramHash(this.key(root))}.json`); }
  async read(root: string): Promise<ReportCache | undefined> {
    try {
      const value = schema.parse(JSON.parse(await fs.readFile(this.filename(root), 'utf8')));
      return value.root === this.key(root) ? value : undefined;
    } catch { return undefined; }
  }
  async write(root: string, report: ProjectReport, analyses: DiagramAnalysis[], reductions: ReportReduction[] = []): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const filename = this.filename(root), temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, root: this.key(root), report, analyses, reductions }), 'utf8');
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async update(root: string, diagrams: { path: string; content: string }[], lastCommit: string | null,
    generate: (analyses: DiagramAnalysis[], reductions: ReportReduction[]) => Promise<{ report: ProjectReport; analyses: DiagramAnalysis[]; reductions?: ReportReduction[] }>, fromScratch = false): Promise<ProjectReport> {
    const cached = fromScratch ? undefined : await this.read(root);
    const previous = new Map(cached?.analyses.map(entry => [entry.path, entry.hash]));
    if (cached && diagrams.length === cached.analyses.length && diagrams.every(source => previous.get(source.path) === diagramHash(source.content))) return cached.report;
    const result = await generate(cached?.analyses ?? [], cached?.reductions ?? []);
    const report = { ...result.report, lastCommit, generatedAt: new Date().toISOString() };
    await this.write(root, report, result.analyses, result.reductions);
    return report;
  }
  run(root: string, operation: () => Promise<ProjectReport>): Promise<ProjectReport> {
    const key = this.key(root), running = this.active.get(key);
    if (running) return running;
    const pending = Promise.resolve().then(operation).finally(() => { if (this.active.get(key) === pending) this.active.delete(key); });
    this.active.set(key, pending);
    return pending;
  }
}

export function reportSourceCommit(root: string): Promise<string | null> {
  return new Promise(resolve => execFile('git', ['-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', '--verify', 'HEAD'],
    { windowsHide: true, timeout: 5000, maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (error, stdout) => resolve(!error && /^[a-f0-9]{40,64}$/i.test(stdout.trim()) ? stdout.trim() : null)));
}
