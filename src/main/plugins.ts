import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PluginMatch { id: string; name: string; description: string; source: 'built-in' | 'project'; }

const builtIns: PluginMatch[] = [
  { id: 'playwright', name: 'Playwright', description: 'Browser automation and end-to-end testing. Use it to test web apps, inspect browser behavior, or reproduce UI flows. It is bundled with Mercury; request a command before running browser tests.', source: 'built-in' },
  { id: 'workspace-files', name: 'Workspace files', description: 'Read and create Markdown, source code, JSON, text, and simple text PDFs inside the selected project.', source: 'built-in' },
];

type Manifest = { id?: unknown; name?: unknown; description?: unknown; keywords?: unknown };
async function projectPlugins(root: string): Promise<(PluginMatch & { keywords: string[] })[]> {
  const directory = path.join(root, '.mercury', 'plugins');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: (PluginMatch & { keywords: string[] })[] = [];
  for (const entry of entries.slice(0, 40)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, entry.name, 'plugin.json'), 'utf8')) as Manifest;
      if (typeof manifest.id !== 'string' || typeof manifest.name !== 'string' || typeof manifest.description !== 'string') continue;
      found.push({ id: manifest.id.slice(0, 80), name: manifest.name.slice(0, 120), description: manifest.description.slice(0, 1000), source: 'project', keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((value): value is string => typeof value === 'string').slice(0, 30) : [] });
    } catch { /* Invalid manifests are deliberately ignored. */ }
  }
  return found;
}

/** Searches declarative manifests only; discovery never executes or installs a plugin. */
export async function discoverPlugins(root: string, query: string): Promise<PluginMatch[]> {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 2).slice(0, 20);
  const candidates = [...builtIns.map(item => ({ ...item, keywords: [] as string[] })), ...await projectPlugins(root)];
  return candidates.map(item => ({ item, score: terms.reduce((score, term) => score + Number(`${item.id} ${item.name} ${item.description} ${item.keywords.join(' ')}`.toLowerCase().includes(term)), 0) }))
    .filter(({ score }) => score > 0 || terms.length === 0).sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name)).slice(0, 12)
    .map(({ item: { keywords: _keywords, ...item } }) => item);
}
