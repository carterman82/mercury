import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Workspace } from './workspace';

export interface CommandSnapshot { digest: string; complete: boolean; entries: { path: string; fingerprint: string }[]; }
export interface SnapshotIO { list(): Promise<string[]>; stat(file: string): Promise<{ size: number; mtimeMs: number }>; read(file: string): Promise<Buffer>; }
/** Selection is decided in path order, never by asynchronous stat completion. */
export async function commandSnapshot(root: string, io?: SnapshotIO, budget = 64000000, signal?: AbortSignal): Promise<CommandSnapshot> {
  signal?.throwIfAborted();
  const workspace = new Workspace(root);
  const source = io ?? { list: () => workspace.list('', 100001), stat: async (file: string) => fs.stat(await workspace.resolve(file)), read: async (file: string) => fs.readFile(await workspace.resolve(file)) };
  const paths = [...await source.list()].sort();
  signal?.throwIfAborted();
  let complete = paths.length < (io ? 1001 : 100001), used = 0;
  const metadata = await Promise.all(paths.map(async path => {
    try { return { path, stat: await source.stat(path) }; } catch { return { path, stat: undefined }; }
  }));
  const selected = metadata.map(item => {
    const read = Boolean(item.stat && (!io || (item.stat.size <= 16000000 && used + item.stat.size <= budget)));
    if (read) used += item.stat!.size; else complete = false;
    return { ...item, read };
  });
  const entries: CommandSnapshot['entries'] = new Array(selected.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      signal?.throwIfAborted();
      const index = next++, item = selected[index];
      let fingerprint = item.stat ? `metadata:${item.stat.size}:${item.stat.mtimeMs}` : 'unreadable';
      if (item.read) try {
        const hash = createHash('sha256');
        let length = 0;
        if (io) { const bytes = await source.read(item.path); length = bytes.length; hash.update(bytes); }
        else for await (const chunk of createReadStream(await workspace.resolve(item.path), { signal })) { length += chunk.length; hash.update(chunk); }
        const after = await source.stat(item.path);
        if (length !== item.stat!.size || after.size !== item.stat!.size || after.mtimeMs !== item.stat!.mtimeMs) { complete = false; fingerprint = 'unstable'; }
        else fingerprint = hash.digest('hex');
      } catch { complete = false; fingerprint = 'unreadable'; }
      entries[index] = { path: item.path, fingerprint };
    }
  }));
  signal?.throwIfAborted();
  return { digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), complete, entries };
}
export function compareCommandSnapshots(before: CommandSnapshot, after: CommandSnapshot) {
  const prior = new Map(before.entries.map(entry => [entry.path, entry.fingerprint]));
  const current = new Map(after.entries.map(entry => [entry.path, entry.fingerprint]));
  let uncertain = !before.complete || !after.complete;
  const changedPaths = [...new Set([...prior.keys(), ...current.keys()])].filter(file => {
    const left = prior.get(file), right = current.get(file);
    if (left === right) return false;
    // Missing entries are conclusive only when the corresponding listing was complete.
    if (left === undefined || right === undefined) {
      if (left === undefined ? before.complete : after.complete) return true;
      uncertain = true; return false;
    }
    const kind = (value: string) => /^[a-f0-9]{64}$/.test(value) ? 'hash' : value.startsWith('metadata:') ? 'metadata' : 'unknown';
    if (kind(left) === 'unknown' || kind(right) === 'unknown' || kind(left) !== kind(right)) {
      uncertain = true; return false;
    }
    return true;
  }).sort();
  return { state: changedPaths.length ? 'changed' as const : uncertain ? 'unknown' as const : 'unchanged' as const, changedPaths: changedPaths.slice(0, 20) };
}
