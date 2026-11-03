import type { DependencyConfidence, ProjectDependencyGraph } from './project-map-types';

export const ARCHITECTURE_EVIDENCE_VERSION = 1;
export interface ArchitectureEvidenceIndex { version: number; sourceFingerprint: string; coverage: ProjectDependencyGraph['coverage']; boundaries: { id: string; path: string; files: number; entryPoint: boolean }[]; relationships: { source: string; target: string; type: 'calls' | 'imports' | 'configuration'; count: number; confidence: DependencyConfidence; evidence: string[] }[]; omittedRelationships: number; }
const boundaryFor = (path: string) => path.includes('/') ? path.split('/')[0] : '(root)';
const rank: Record<DependencyConfidence, number> = { confirmed: 3, inferred: 2, unresolved: 1 };

/** Collapse source-level dependencies before any model sees them. */
export function buildArchitectureEvidence(graph: ProjectDependencyGraph, maxRelationships = 36): ArchitectureEvidenceIndex {
  const files = new Map(graph.files.map(file => [file.id, file]));
  const symbols = new Map(graph.symbols.map(symbol => [symbol.id, symbol]));
  const endpoint = (id: string | null) => { const file = id ? files.get(id) : undefined; const symbol = id ? symbols.get(id) : undefined; return file ? boundaryFor(file.path) : symbol ? boundaryFor(symbol.file) : 'external:unresolved'; };
  const boundaries = new Map<string, { id: string; path: string; files: number; entryPoint: boolean }>();
  for (const file of graph.files) { const path = boundaryFor(file.path); const item = boundaries.get(path) ?? { id: `boundary:${path}`, path, files: 0, entryPoint: false }; item.files++; boundaries.set(path, item); }
  const aggregate = new Map<string, ArchitectureEvidenceIndex['relationships'][number]>();
  for (const edge of graph.edges) {
    const source = endpoint(edge.from), target = endpoint(edge.to); if (source === target) continue;
    const key = `${source}\0${target}\0${edge.kind}`, evidence = `${edge.file}:${edge.line} ${edge.label}`.slice(0, 180), prior = aggregate.get(key);
    if (prior) { prior.count++; if (rank[edge.confidence] < rank[prior.confidence]) prior.confidence = edge.confidence; if (prior.evidence.length < 3 && !prior.evidence.includes(evidence)) prior.evidence.push(evidence); }
    else aggregate.set(key, { source, target, type: edge.kind, count: 1, confidence: edge.confidence, evidence: [evidence] });
    if (edge.kind === 'configuration' && boundaries.has(source)) boundaries.get(source)!.entryPoint = true;
  }
  const all = [...aggregate.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type));
  const required = all.filter(edge => edge.target.startsWith('external:') || edge.type === 'configuration');
  // Keep the payload hard-bounded even for unusual projects with hundreds of
  // config links; omittedRelationships makes that loss explicit to the model.
  const selectedRequired = required.slice(0, maxRelationships);
  const selected = [...selectedRequired, ...all.filter(edge => !required.includes(edge)).slice(0, Math.max(0, maxRelationships - selectedRequired.length))].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type));
  return { version: ARCHITECTURE_EVIDENCE_VERSION, sourceFingerprint: graph.sourceFingerprint, coverage: graph.coverage, boundaries: [...boundaries.values()].sort((a, b) => a.path.localeCompare(b.path)), relationships: selected, omittedRelationships: all.length - selected.length };
}
export const serializeArchitectureEvidence = (index: ArchitectureEvidenceIndex) => JSON.stringify(index);
