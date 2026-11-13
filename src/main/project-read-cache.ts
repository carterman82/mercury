import type { ProjectReadReuse, ProjectProgressObservation } from '../shared/types';
import type { Workspace } from './workspace';

type Page = Awaited<ReturnType<Workspace['read']>>;
type Cached = { page: Page; originEvidenceId?: string; bytes: number; lastHash: string };

/** Only the already-authorized read handler may populate or reuse these pages. */
export class ProjectReadCache {
  private entries = new Map<string, Cached>();
  private bytes = 0;
  constructor(private maximumEntries = 64, private maximumBytes = 2 * 1024 * 1024) {}
  private key(target: string, page: Pick<Page, 'hash' | 'startLine' | 'endLine'>) {
    return JSON.stringify([process.platform === 'win32' ? target.toLowerCase() : target, page.hash, page.startLine, page.endLine]);
  }
  validated(target: string, current: Page): Page & { sourcePath: string; readReuse?: ProjectReadReuse } {
    const key = this.key(target, current);
    const prior = this.entries.get(key);
    if (prior) {
      // Validate that the file hasn't changed externally
      if (prior.lastHash === current.hash) {
        // Move to end for LRU eviction
        this.entries.delete(key); this.entries.set(key, prior);
        return { ...prior.page, sourcePath: target, readReuse: { kind: 'validated-cache', originEvidenceId: prior.originEvidenceId } };
      }
    }
    // File has changed or is new - add to cache
    const bytes = Buffer.byteLength(JSON.stringify(current));
    if (bytes <= this.maximumBytes) {
      const entry: Cached = { page: { ...current }, bytes, lastHash: current.hash };
      this.entries.set(key, entry); this.bytes += bytes;
      while (this.entries.size > this.maximumEntries || this.bytes > this.maximumBytes) {
        const first = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first);
      }
    }
    return { ...current, sourcePath: target };
  }
  recordEvidence(target: string, page: Pick<Page, 'hash' | 'startLine' | 'endLine'>, id: string): void {
    const entry = this.entries.get(this.key(target, page));
    if (entry && !entry.originEvidenceId) {
      entry.originEvidenceId = id;
    }
  }
  /**
   * Check if a cached page is still valid (file hash hasn't changed externally).
   * Returns the cached entry if valid, undefined otherwise.
   */
  validateHash(target: string, page: Pick<Page, 'hash' | 'startLine' | 'endLine'>): boolean {
    const entry = this.entries.get(this.key(target, page));
    return Boolean(entry && entry.lastHash === page.hash);
  }
}
