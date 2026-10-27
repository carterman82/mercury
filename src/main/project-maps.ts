import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TypeScriptDependencyAnalyzer, TreeSitterDependencyAnalyzer, dependencyFileId } from './project-map-analyzers';
import type {
  AnalyzedSource,
  DependencyDiagnostic,
  DependencyEdge,
  DependencyLanguage,
  DependencySymbol,
  MapSource,
  ProjectDependencyGraph,
  RawImport,
} from './project-map-types';
export type { ProjectDependencyGraph, DependencyLanguage, DependencySymbol, DependencyEdge } from './project-map-types';

const ANALYZER_VERSION = 'mercury-dependencies-1';
const MAX_FILES = 2000,
  MAX_FILE_BYTES = 1024 * 1024,
  MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const GRAPH_LIMIT = 32 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const extensionLanguages: Record<string, DependencyLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
};
const skippedDirectories = new Set([
  '.git',
  '.mercury',
  'node_modules',
  'dist',
  'build',
  'out',
  '.vite',
  '.next',
  'coverage',
  '.cache',
  '__pycache__',
  'vendor',
  'target',
  '.venv',
  'venv',
]);
const configurationNames = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'cmakelists.txt',
  'makefile',
]);
function languageFor(filename: string): DependencyLanguage | undefined {
  return (
    extensionLanguages[path.extname(filename).toLowerCase()] ??
    (configurationNames.has(path.basename(filename).toLowerCase()) || /\.(?:csproj|props|targets)$/i.test(filename)
      ? 'configuration'
      : undefined)
  );
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
const portable = (value: string) => value.replaceAll('\\', '/');
const md = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
const label = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\r\n]/g, ' ');
function edge(
  from: string,
  to: string | null,
  kind: DependencyEdge['kind'],
  item: { file: string; line: number; column: number },
  text: string,
  confidence: DependencyEdge['confidence'],
  reason?: string,
): DependencyEdge {
  return {
    id: 'e_' + hash(JSON.stringify([from, to, kind, item.file, item.line, item.column, text])).slice(0, 24),
    kind,
    from,
    to,
    ...item,
    label: text,
    confidence,
    ...(reason ? { reason } : {}),
  };
}

interface Scan {
  root: string;
  sources: MapSource[];
  diagnostics: DependencyDiagnostic[];
  truncated: boolean;
  fingerprint: string;
}
interface Manifest {
  schemaVersion: 1;
  sourceFingerprint: string;
  diagrams: string[];
  generated: string[];
  fingerprints: Record<string, string>;
}
export interface ProjectMapStatus {
  available: boolean;
  fresh: boolean;
  persisted: boolean;
  sourceFingerprint?: string;
  currentFingerprint: string;
  sourceFiles: number;
  languages: DependencyLanguage[];
  unresolvedReferences: number;
  diagrams: string[];
  diagramLabels?: Record<string, string>;
  diagnostics: DependencyDiagnostic[];
}
export interface ProjectMapQuery {
  query?: string;
  file?: string;
  limit?: number;
}

async function scan(root: string, signal?: AbortSignal): Promise<Scan> {
  const canonical = await fs.realpath(root);
  const sources: MapSource[] = [],
    diagnostics: DependencyDiagnostic[] = [];
  let bytes = 0,
    truncated = false;
  const walk = async (directory: string, depth: number) => {
    signal?.throwIfAborted();
    if (sources.length >= MAX_FILES || bytes >= MAX_SOURCE_BYTES || depth > 24) {
      truncated = true;
      return;
    }
    const actual = await fs.realpath(directory);
    if (!within(canonical, actual) || actual !== directory) {
      diagnostics.push({ message: 'A linked directory was skipped.' });
      return;
    }
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    );
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (sources.length >= MAX_FILES || bytes >= MAX_SOURCE_BYTES) {
        truncated = true;
        return;
      }
      const absolute = path.join(directory, entry.name),
        relative = portable(path.relative(canonical, absolute));
      if (entry.isSymbolicLink()) {
        diagnostics.push({ file: relative, message: 'Symbolic link/junction skipped.' });
        continue;
      }
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name.toLowerCase())) await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = languageFor(entry.name);
      if (!language) continue;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || (await fs.realpath(absolute)) !== absolute) {
        diagnostics.push({ file: relative, message: 'Linked or non-regular source skipped.' });
        continue;
      }
      if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_SOURCE_BYTES) {
        diagnostics.push({ file: relative, message: 'Source size limit exceeded; not analyzed.' });
        truncated = true;
        continue;
      }
      const handle = await fs.open(absolute, 'r');
      let data: Buffer;
      try {
        data = Buffer.alloc(MAX_FILE_BYTES + 1);
        const read = await handle.read(data, 0, data.length, 0);
        data = data.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
      if (data.length > MAX_FILE_BYTES || data.includes(0)) {
        diagnostics.push({ file: relative, message: 'Oversized or binary source skipped.' });
        truncated = true;
        continue;
      }
      bytes += data.length;
      sources.push({ path: relative, absolute, language, content: data.toString('utf8'), fingerprint: hash(data) });
    }
  };
  await walk(canonical, 0);
  sources.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (truncated)
    diagnostics.push({
      message: 'Analysis is bounded to 2,000 files, 1 MiB per file, 32 MiB total source, and 24 directory levels.',
    });
  return {
    root: canonical,
    sources,
    diagnostics,
    truncated,
    fingerprint: hash(
      JSON.stringify([ANALYZER_VERSION, sources.map((source) => [source.path, source.fingerprint]), diagnostics]),
    ),
  };
}

/** Generated paths are fixed/hashed names; every existing component is checked before writes. */
async function mapPath(root: string, relative: string, createParents = false): Promise<string> {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => part === '..' || !part || part === '.')
  )
    throw new Error('Invalid architecture map path.');
  let current = root;
  const components = ['.mercury', 'architecture', ...relative.split('/')];
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink() || (stat && !within(root, await fs.realpath(current))))
      throw new Error('Architecture maps cannot follow links outside their project.');
    if (index < components.length - 1) {
      if (stat && !stat.isDirectory()) throw new Error('Architecture map parent is not a directory.');
      if (!stat && createParents) await fs.mkdir(current);
    } else if (stat && !stat.isFile()) throw new Error('Architecture maps must be regular files.');
  }
  return current;
}
async function writeMap(root: string, relative: string, content: string): Promise<void> {
  const target = await mapPath(root, relative, true);
  if ((await fs.readFile(target, 'utf8').catch(() => null)) === content) return;
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    await mapPath(root, relative);
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function importTargets(item: RawImport, source: MapSource, sources: MapSource[], analyzed: AnalyzedSource[]): string[] {
  if (item.resolvedFiles) return item.resolvedFiles;
  const available = new Set(sources.map((file) => file.path));
  const candidates = new Set<string>();
  const add = (value: string) => {
    const normalized = portable(path.posix.normalize(value));
    if (!normalized.startsWith('../') && available.has(normalized)) candidates.add(normalized);
  };
  const specifier = item.source;
  if (source.language === 'python') {
    const leading = specifier.match(/^\.+/)?.[0].length ?? 0;
    let base = leading ? path.posix.dirname(source.path) : '';
    for (let index = 1; index < leading; index++) base = path.posix.dirname(base);
    const module = specifier.slice(leading).replaceAll('.', '/');
    for (const prefix of [base, 'src']) {
      add(path.posix.join(prefix, module + '.py'));
      add(path.posix.join(prefix, module, '__init__.py'));
    }
  } else if (source.language === 'java') {
    const module = specifier.replaceAll('.', '/');
    for (const file of sources)
      if (
        file.language === 'java' &&
        (file.path === module + '.java' ||
          file.path.endsWith('/' + module + '.java') ||
          analyzed.find((unit) => unit.path === file.path)?.moduleName === specifier)
      )
        add(file.path);
  } else if (source.language === 'csharp') {
    for (const unit of analyzed)
      if (
        sources.find((file) => file.path === unit.path)?.language === 'csharp' &&
        (unit.moduleName === specifier || unit.symbols.some((symbol) => symbol.qualifiedName === specifier))
      )
        add(unit.path);
  } else if (source.language === 'go') {
    const module = sources.find((file) => file.path === 'go.mod')?.content.match(/^module\s+(\S+)/m)?.[1];
    const directory = module && specifier.startsWith(module + '/') ? specifier.slice(module.length + 1) : specifier;
    for (const file of sources)
      if (file.language === 'go' && path.posix.dirname(file.path) === directory) add(file.path);
  } else if (source.language === 'rust') {
    const module = specifier
      .replace(/^crate::/, '')
      .replace(/^self::/, '')
      .replaceAll('::', '/');
    for (const prefix of ['', 'src', path.posix.dirname(source.path)]) {
      add(path.posix.join(prefix, module + '.rs'));
      add(path.posix.join(prefix, module, 'mod.rs'));
    }
  } else if (source.language === 'c' || source.language === 'cpp') {
    for (const prefix of [path.posix.dirname(source.path), '', 'include', 'src'])
      add(path.posix.join(prefix, specifier));
  }
  return [...candidates].sort();
}

function link(sources: MapSource[], units: AnalyzedSource[]): { symbols: DependencySymbol[]; edges: DependencyEdge[] } {
  const symbols = units.flatMap((unit) => unit.symbols).sort((a, b) => a.id.localeCompare(b.id));
  const edges: DependencyEdge[] = [];
  const byFile = new Map(sources.map((source) => [source.path, source]));
  for (const unit of units) {
    const source = byFile.get(unit.path)!;
    const imports = unit.imports.map((item) => ({ item, targets: importTargets(item, source, sources, units) }));
    for (const { item, targets } of imports) {
      if (!targets.length)
        edges.push(
          edge(
            dependencyFileId(unit.path),
            null,
            'imports',
            item,
            item.source,
            'unresolved',
            'External or unresolved module; no project code was executed to resolve it.',
          ),
        );
      for (const target of targets)
        edges.push(
          edge(dependencyFileId(unit.path), dependencyFileId(target), 'imports', item, item.source, 'confirmed'),
        );
    }
    for (const call of unit.calls) {
      if (call.target) {
        edges.push(
          edge(call.caller, call.target, 'calls', call, call.expression, call.confidence ?? 'inferred', call.reason),
        );
        continue;
      }
      let candidates: DependencySymbol[] = [];
      if (!call.reason && source.language !== 'typescript' && source.language !== 'javascript') {
        const local = unit.symbols.filter((symbol) => symbol.kind !== 'class' && symbol.name === call.name);
        const imported = imports.flatMap(({ item, targets }) => {
          const binding = item.names.find((name) => name.local === (call.receiver ?? call.name));
          if (!binding && item.names.length && source.language !== 'c' && source.language !== 'cpp') return [];
          const targetName = binding && binding.imported !== '*' ? binding.imported : call.name;
          return symbols.filter(
            (symbol) =>
              targets.includes(symbol.file) &&
              symbol.name === targetName &&
              symbol.kind !== 'class' &&
              (!call.receiver ||
                !symbol.owner ||
                symbol.owner === call.receiver ||
                symbol.owner.endsWith('.' + call.receiver) ||
                binding?.imported === '*'),
          );
        });
        if (call.receiver) {
          candidates = [
            ...local.filter((symbol) => symbol.owner === call.receiver || symbol.owner?.endsWith('.' + call.receiver)),
            ...imported,
          ];
          if (!candidates.length)
            candidates = symbols.filter(
              (symbol) =>
                symbol.name === call.name &&
                symbol.owner &&
                (symbol.owner === call.receiver || symbol.owner.endsWith('.' + call.receiver)) &&
                (symbol.file === unit.path || imports.some((imported) => imported.targets.includes(symbol.file))),
            );
          if (!candidates.length && (source.language === 'c' || source.language === 'cpp')) {
            const included = imports.flatMap((imported) =>
              imported.targets.map((file) => path.posix.basename(file, path.posix.extname(file))),
            );
            candidates = symbols.filter(
              (symbol) =>
                symbol.name === call.name &&
                symbol.kind !== 'class' &&
                included.includes(path.posix.basename(symbol.file, path.posix.extname(symbol.file))) &&
                (symbol.owner === call.receiver || symbol.owner?.endsWith('.' + call.receiver)),
            );
          }
        } else {
          candidates = local.length ? local : imported;
          if (!candidates.length && source.language === 'go')
            candidates = symbols.filter(
              (symbol) =>
                symbol.name === call.name &&
                symbol.kind === 'function' &&
                path.posix.dirname(symbol.file) === path.posix.dirname(unit.path),
            );
          if (!candidates.length && (source.language === 'c' || source.language === 'cpp')) {
            const included = imports.flatMap((imported) =>
              imported.targets.map((file) => path.posix.basename(file, path.posix.extname(file))),
            );
            candidates = symbols.filter(
              (symbol) =>
                symbol.name === call.name &&
                symbol.kind !== 'class' &&
                included.includes(path.posix.basename(symbol.file, path.posix.extname(symbol.file))),
            );
          }
        }
      }
      candidates = [...new Map(candidates.map((symbol) => [symbol.id, symbol])).values()];
      edges.push(
        edge(
          call.caller,
          candidates.length === 1 ? candidates[0].id : null,
          'calls',
          call,
          call.expression,
          candidates.length === 1 ? 'inferred' : 'unresolved',
          call.reason ??
            (candidates.length === 1
              ? 'Static syntax/name match; runtime dispatch and language build context were not evaluated.'
              : candidates.length > 1
                ? 'Ambiguous implementations or overloads; no target was guessed.'
                : 'Dynamic, external, or unresolved call.'),
        ),
      );
    }
  }
  // Configuration references are explicitly inferred textual references, never executable build evaluation.
  for (const source of sources.filter((file) => file.language === 'configuration')) {
    for (const target of sources) {
      if (target.path === source.path) continue;
      const relative = path.posix.relative(path.posix.dirname(source.path), target.path);
      const offset = source.content.indexOf(relative);
      if (offset < 0 || relative.length < 3) continue;
      const prefix = source.content.slice(0, offset).split('\n');
      edges.push(
        edge(
          dependencyFileId(source.path),
          dependencyFileId(target.path),
          'configuration',
          { file: source.path, line: prefix.length, column: prefix.at(-1)!.length + 1 },
          relative,
          'inferred',
          'Textual configuration reference; build logic was not executed.',
        ),
      );
    }
  }
  return {
    symbols,
    edges: [...new Map(edges.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function diagram(nodes: { id: string; text: string }[], edges: DependencyEdge[]): string {
  const known = new Set(nodes.map((node) => node.id));
  return [
    'flowchart LR',
    ...nodes.map((node) => `  ${node.id}["${label(node.text)}"]`),
    ...edges
      .filter((item) => item.to && known.has(item.from) && known.has(item.to))
      .map((item) => `  ${item.from} ${item.confidence === 'inferred' ? '-.->' : '-->'} ${item.to}`),
    '',
  ].join('\n');
}

/** Partition by edges, including both boundary endpoints, so cross-partition dependencies never disappear. */
function diagramParts(nodes: { id: string; text: string }[], edges: DependencyEdge[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const displayed = edges
    .filter((item) => byId.has(item.from))
    .map((item) => {
      if (item.to) return item;
      const target = 'u_' + item.id;
      byId.set(target, { id: target, text: `Unresolved: ${item.label}` });
      return { ...item, to: target };
    })
    .filter((item) => item.to && byId.has(item.to));
  const parts: string[] = [],
    shown = new Set<string>();
  for (let offset = 0; offset < displayed.length; offset += 40) {
    const chunk = displayed.slice(offset, offset + 40);
    const endpoints = [...new Set(chunk.flatMap((item) => [item.from, item.to!]))];
    endpoints.forEach((value) => shown.add(value));
    parts.push(
      diagram(
        endpoints.map((value) => byId.get(value)!),
        chunk,
      ),
    );
  }
  const isolated = nodes.filter((node) => !shown.has(node.id));
  for (let offset = 0; offset < isolated.length; offset += 80)
    parts.push(diagram(isolated.slice(offset, offset + 80), []));
  return parts.length ? parts : ['flowchart LR\n'];
}

export class ProjectMaps {
  private tree: TreeSitterDependencyAnalyzer;
  private typescript = new Map<string, TypeScriptDependencyAnalyzer>();
  private units = new Map<string, { fingerprint: string; unit: AnalyzedSource }>();
  private pending = new Map<string, Promise<unknown>>();
  private graphs = new Map<string, { graph: ProjectDependencyGraph; persisted: boolean }>();
  constructor(options: { runtimeRoot?: string; grammarRoot?: string } = {}) {
    this.tree = new TreeSitterDependencyAnalyzer(options);
  }
  private async load(root: string): Promise<ProjectDependencyGraph | null> {
    try {
      const filename = await mapPath(root, 'graph.json');
      if ((await fs.stat(filename)).size > GRAPH_LIMIT) throw new Error('Dependency graph exceeds the read limit.');
      const graph = JSON.parse(await fs.readFile(filename, 'utf8')) as ProjectDependencyGraph;
      if (
        graph.schemaVersion !== 1 ||
        !Array.isArray(graph.files) ||
        !Array.isArray(graph.symbols) ||
        !Array.isArray(graph.edges) ||
        !Array.isArray(graph.diagnostics) ||
        !graph.coverage
      )
        throw new Error('Invalid dependency graph. Refresh maps to rebuild it.');
      return graph;
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  private async manifest(root: string): Promise<Manifest | null> {
    try {
      const filename = await mapPath(root, 'manifest.json');
      if ((await fs.stat(filename)).size > 4 * 1024 * 1024) return null;
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8')) as Manifest;
      if (
        manifest.schemaVersion !== 1 ||
        !Array.isArray(manifest.diagrams) ||
        !Array.isArray(manifest.generated) ||
        !manifest.fingerprints ||
        typeof manifest.fingerprints !== 'object'
      )
        return null;
      return manifest;
    } catch (error: any) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  private async artifactsIntact(root: string, graph: ProjectDependencyGraph): Promise<boolean> {
    const manifest = await this.manifest(root);
    if (!manifest || manifest.sourceFingerprint !== graph.sourceFingerprint) return false;
    for (const relative of manifest.generated) {
      if (typeof relative !== 'string' || typeof manifest.fingerprints[relative] !== 'string') return false;
      try {
        const filename = await mapPath(root, relative);
        const stat = await fs.stat(filename);
        if (
          !stat.isFile() ||
          stat.size > GRAPH_LIMIT ||
          hash(await fs.readFile(filename)) !== manifest.fingerprints[relative]
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  async refresh(
    root: string,
    signal?: AbortSignal,
    options: { persist?: boolean } = {},
  ): Promise<ProjectDependencyGraph> {
    const canonical = await fs.realpath(root);
    const persist = options.persist !== false;
    const previous = this.pending.get(canonical) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const scanned = await scan(canonical, signal);
        const cached = this.graphs.get(canonical);
        const existing = cached?.graph ?? (await this.load(canonical).catch(() => null));
        if (
          existing?.analyzerVersion === ANALYZER_VERSION &&
          existing.sourceFingerprint === scanned.fingerprint &&
          existing.coverage.parsedFiles === existing.coverage.totalFiles &&
          !existing.diagnostics.some((diagnostic) => diagnostic.message.startsWith('Parser unavailable:')) &&
          (!persist || (await this.artifactsIntact(canonical, existing)))
        ) {
          this.graphs.set(canonical, { graph: existing, persisted: persist || Boolean(cached?.persisted) });
          return existing;
        }
        const units: AnalyzedSource[] = [],
          diagnostics = [...scanned.diagnostics];
        const typescriptSources = scanned.sources.filter(
          (source) => source.language === 'typescript' || source.language === 'javascript',
        );
        let analyzer = this.typescript.get(canonical);
        if (!analyzer) {
          analyzer = new TypeScriptDependencyAnalyzer();
          this.typescript.set(canonical, analyzer);
        }
        units.push(...analyzer.analyze(canonical, typescriptSources, signal));
        for (const source of scanned.sources.filter(
          (source) => !['typescript', 'javascript', 'configuration'].includes(source.language),
        )) {
          signal?.throwIfAborted();
          const key = `${canonical}\0${source.path}`,
            cached = this.units.get(key);
          try {
            const unit =
              cached?.fingerprint === source.fingerprint ? cached.unit : await this.tree.analyze(source, signal);
            this.units.set(key, { fingerprint: source.fingerprint, unit });
            units.push(unit);
          } catch (error) {
            signal?.throwIfAborted();
            diagnostics.push({
              file: source.path,
              message: `Parser unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
            });
          }
        }
        const linked = link(scanned.sources, units);
        const graph: ProjectDependencyGraph = {
          schemaVersion: 1,
          analyzerVersion: ANALYZER_VERSION,
          sourceFingerprint: scanned.fingerprint,
          files: scanned.sources.map((source) => ({
            id: dependencyFileId(source.path),
            path: source.path,
            language: source.language,
            fingerprint: source.fingerprint,
          })),
          symbols: linked.symbols,
          edges: linked.edges,
          diagnostics: [...diagnostics, ...units.flatMap((unit) => unit.diagnostics)],
          coverage: {
            languages: [...new Set(scanned.sources.map((source) => source.language))].sort(),
            parsedFiles: units.length + scanned.sources.filter((source) => source.language === 'configuration').length,
            totalFiles: scanned.sources.length,
            truncated: scanned.truncated,
            unresolvedReferences: linked.edges.filter((item) => item.confidence === 'unresolved').length,
          },
        };
        if (Buffer.byteLength(JSON.stringify(graph)) > GRAPH_LIMIT)
          throw new Error('Dependency graph exceeds the 32 MiB storage limit. Analyze a smaller source project.');
        signal?.throwIfAborted();
        if (persist) await this.write(scanned.root, graph, signal);
        this.graphs.set(canonical, { graph, persisted: persist });
        return graph;
      });
    this.pending.set(canonical, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(canonical) === operation) this.pending.delete(canonical);
    }
  }
  private async write(root: string, graph: ProjectDependencyGraph, signal?: AbortSignal): Promise<void> {
    const generated = new Map<string, string>();
    const groups = new Map<string, typeof graph.files>();
    for (const file of graph.files) {
      const group = file.path.includes('/') ? file.path.split('/')[0] : '(root)';
      const list = groups.get(group) ?? [];
      list.push(file);
      groups.set(group, list);
    }
    const subsystemNodes = [...groups.keys()]
      .sort()
      .map((group) => ({ id: 'g_' + hash(group).slice(0, 16), text: group }));
    const fileGroups = new Map(
      graph.files.map((file) => [file.id, file.path.includes('/') ? file.path.split('/')[0] : '(root)']),
    );
    const subsystemEdges = graph.edges
      .filter((item) => item.kind === 'imports' && item.to && fileGroups.get(item.from) !== fileGroups.get(item.to))
      .map((item) => ({
        ...item,
        from: 'g_' + hash(fileGroups.get(item.from)!).slice(0, 16),
        to: 'g_' + hash(fileGroups.get(item.to!)!).slice(0, 16),
      }));
    diagramParts(subsystemNodes, subsystemEdges).forEach((part, index) =>
      generated.set(
        index ? `generated/subsystems-${String(index).padStart(3, '0')}.mmd` : 'generated/subsystems.mmd',
        part,
      ),
    );
    diagramParts(
      graph.files.map((file) => ({ id: file.id, text: file.path })),
      graph.edges.filter((item) => item.kind !== 'calls'),
    ).forEach((part, index) => generated.set(`generated/files-${String(index).padStart(3, '0')}.mmd`, part));
    for (const file of graph.files) {
      signal?.throwIfAborted();
      const local = graph.symbols.filter((symbol) => symbol.file === file.path);
      const relevant = graph.edges.filter(
        (item) =>
          item.kind === 'calls' &&
          (item.file === file.path || (item.to && local.some((symbol) => symbol.id === item.to))),
      );
      const referenced = new Set(relevant.flatMap((item) => [item.from, ...(item.to ? [item.to] : [])]));
      const nodes = [
        { id: file.id, text: file.path },
        ...local.map((symbol) => ({ id: symbol.id, text: `${symbol.qualifiedName} · ${symbol.line}` })),
        ...graph.symbols
          .filter((symbol) => symbol.file !== file.path && referenced.has(symbol.id))
          .map((symbol) => ({ id: symbol.id, text: `${symbol.file}: ${symbol.qualifiedName}` })),
      ];
      diagramParts(nodes, relevant).forEach((part, index) =>
        generated.set(`generated/methods/${file.id}-${String(index).padStart(3, '0')}.mmd`, part),
      );
    }
    const systemPath = await mapPath(root, 'system.mmd', true);
    try {
      await fs.writeFile(
        systemPath,
        'flowchart LR\n  project["Project system"] --> modules["Source modules — see generated subsystem maps"]\n',
        { flag: 'wx' },
      );
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
    const diagrams = ['system.mmd', ...generated.keys()].sort();
    const index = [
      '# Project architecture',
      '',
      'The system diagram is model-maintained. Files under generated/ are derived from captured source and overwritten on refresh.',
      '',
      `Source fingerprint: ${graph.sourceFingerprint}`,
      `Analyzer: ${graph.analyzerVersion}`,
      `Coverage: ${graph.coverage.parsedFiles}/${graph.coverage.totalFiles} files; ${graph.coverage.unresolvedReferences} unresolved references.`,
      '',
      'Solid edges are confirmed static relationships. Dashed edges are inferred. Unresolved relationships remain in graph.json; absence of an edge is not proof of no dependency.',
      '',
      '## Diagram tree',
      '',
      ...diagrams.map((relative) => `- [${md(relative)}](${relative.split('/').map(encodeURIComponent).join('/')})`),
      '',
      '## Source files',
      '',
      ...graph.files.map(
        (file) => `- ${md(file.path)} (${file.language}) → [methods](generated/methods/${file.id}-000.mmd)`,
      ),
      '',
      '## Limitations',
      '',
      'Dynamic dispatch, reflection, macros, overload ambiguity and unavailable build context are not executed or invented.',
      ...graph.diagnostics.map(
        (diagnostic) => `- ${md(diagnostic.file ? `${diagnostic.file}: ${diagnostic.message}` : diagnostic.message)}`,
      ),
      '',
    ].join('\n');
    generated.set('index.md', index);
    generated.set('graph.json', JSON.stringify(graph, null, 2) + '\n');
    const manifest: Manifest = {
      schemaVersion: 1,
      sourceFingerprint: graph.sourceFingerprint,
      diagrams,
      generated: [...generated.keys()].sort(),
      fingerprints: Object.fromEntries([...generated].map(([relative, content]) => [relative, hash(content)])),
    };
    const oldManifest = await fs.readFile(await mapPath(root, 'manifest.json'), 'utf8').then(
      (value) => {
        try {
          return JSON.parse(value) as Manifest;
        } catch {
          return null;
        }
      },
      () => null,
    );
    for (const [relative, content] of generated) {
      signal?.throwIfAborted();
      await writeMap(root, relative, content);
    }
    for (const relative of Array.isArray(oldManifest?.generated) ? oldManifest.generated : [])
      if (typeof relative === 'string' && relative.startsWith('generated/') && !generated.has(relative)) {
        signal?.throwIfAborted();
        await fs.unlink(await mapPath(root, relative)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    await writeMap(root, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  }
  async status(root: string): Promise<ProjectMapStatus> {
    const scanned = await scan(root);
    const cached = this.graphs.get(scanned.root);
    const graph = cached?.graph ?? (await this.load(scanned.root));
    const manifest = await this.manifest(scanned.root);
    const persisted = cached ? cached.persisted : Boolean(graph);
    const artifacts = !persisted || Boolean(graph && (await this.artifactsIntact(scanned.root, graph)));
    return {
      available: Boolean(graph),
      fresh: Boolean(
        graph &&
        graph.analyzerVersion === ANALYZER_VERSION &&
        graph.sourceFingerprint === scanned.fingerprint &&
        artifacts,
      ),
      persisted,
      sourceFingerprint: graph?.sourceFingerprint,
      currentFingerprint: scanned.fingerprint,
      sourceFiles: scanned.sources.length,
      languages: graph?.coverage.languages ?? [],
      unresolvedReferences: graph?.coverage.unresolvedReferences ?? 0,
      diagramLabels: Object.fromEntries(
        (manifest?.diagrams ?? []).map((value) => [
          value,
          value === 'system.mmd'
            ? 'System interactions'
            : value.includes('/methods/')
              ? (graph?.files.find((file) => value.includes(file.id))?.path ?? value) + ' — methods'
              : value,
        ]),
      ),
      diagrams: (manifest?.diagrams ?? []).filter(
        (value) =>
          typeof value === 'string' && !value.includes('..') && !path.isAbsolute(value) && value.endsWith('.mmd'),
      ),
      diagnostics: [
        ...(graph?.diagnostics ?? scanned.diagnostics),
        ...(!artifacts
          ? [{ message: 'Generated maps are missing or modified. Refresh to rebuild consistent artifacts.' }]
          : []),
      ],
    };
  }
  async query(root: string, input: ProjectMapQuery = {}) {
    const canonical = await fs.realpath(root);
    const graph = this.graphs.get(canonical)?.graph ?? (await this.load(canonical));
    if (!graph) throw new Error('Dependency maps are missing. Refresh them first.');
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
    const search = (input.query ?? '').toLowerCase();
    const symbols = graph.symbols
      .filter(
        (symbol) =>
          (!input.file || symbol.file === input.file) &&
          (!search || `${symbol.qualifiedName} ${symbol.file}`.toLowerCase().includes(search)),
      )
      .slice(0, limit);
    const symbolIds = new Set(symbols.map((symbol) => symbol.id));
    const edges = graph.edges
      .filter(
        (item) =>
          (!input.file ||
            item.file === input.file ||
            symbolIds.has(item.from) ||
            Boolean(item.to && symbolIds.has(item.to))) &&
          (!search ||
            item.label.toLowerCase().includes(search) ||
            symbolIds.has(item.from) ||
            Boolean(item.to && symbolIds.has(item.to))),
      )
      .slice(0, limit);
    return {
      sourceFingerprint: graph.sourceFingerprint,
      symbols,
      edges,
      diagnostics: graph.diagnostics.slice(0, 20),
      note: 'Historical static map results. Check freshness/source before editing; unresolved relationships are not proof of no dependency.',
    };
  }
  async readDiagram(root: string, relative: string): Promise<{ path: string; content: string }> {
    if (!relative.endsWith('.mmd')) throw new Error('Only Mermaid diagrams can be previewed.');
    const canonical = await fs.realpath(root),
      filename = await mapPath(canonical, relative);
    if ((await fs.stat(filename)).size > 256000) throw new Error('Diagram exceeds the preview limit.');
    return { path: relative, content: await fs.readFile(filename, 'utf8') };
  }
}
