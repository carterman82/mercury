import { expect, it } from 'vitest';
import { buildArchitectureEvidence, serializeArchitectureEvidence } from './project-architecture-evidence';
import type { ProjectDependencyGraph } from './project-map-types';

const graph = (edges: ProjectDependencyGraph['edges']): ProjectDependencyGraph => ({
  schemaVersion: 1, analyzerVersion: 'test', sourceFingerprint: 'fixture',
  files: [{ id: 'a', path: 'app/main.ts', language: 'typescript', fingerprint: 'a' }, { id: 'b', path: 'core/service.ts', language: 'typescript', fingerprint: 'b' }, { id: 'c', path: 'core/store.ts', language: 'typescript', fingerprint: 'c' }],
  symbols: [{ id: 'sa', name: 'run', qualifiedName: 'run', kind: 'function', file: 'app/main.ts', line: 1, column: 1, endLine: 1 }, { id: 'sb', name: 'save', qualifiedName: 'save', kind: 'function', file: 'core/service.ts', line: 1, column: 1, endLine: 1 }],
  edges, diagnostics: [], coverage: { languages: ['typescript'], parsedFiles: 3, totalFiles: 3, truncated: false, unresolvedReferences: 0 },
});
const edge = (id: string, from: string, to: string | null, kind: 'calls' | 'imports' | 'configuration' = 'calls', confidence: 'confirmed' | 'inferred' | 'unresolved' = 'confirmed') => ({ id, kind, from, to, label: id, confidence, file: 'app/main.ts', line: 1, column: 1 });

it('aggregates repeated cross-boundary calls while preserving uncertainty and evidence', () => {
  const index = buildArchitectureEvidence(graph([edge('one', 'sa', 'sb'), edge('two', 'sa', 'sb', 'calls', 'inferred'), edge('inside', 'sb', 'c')]));
  expect(index.relationships).toEqual([expect.objectContaining({ source: 'app', target: 'core', count: 2, confidence: 'inferred', evidence: ['app/main.ts:1 one', 'app/main.ts:1 two'] })]);
});

it('preserves cycles, unresolved external systems, and configuration entry-point evidence', () => {
  const index = buildArchitectureEvidence(graph([edge('forward', 'sa', 'sb'), edge('back', 'sb', 'sa'), edge('external', 'sa', null), edge('entry', 'a', 'b', 'configuration')]));
  expect(index.relationships.map(item => `${item.source}:${item.target}`)).toEqual(expect.arrayContaining(['app:core', 'core:app', 'app:external:unresolved']));
  expect(index.boundaries.find(item => item.path === 'app')?.entryPoint).toBe(true);
});

it('keeps model evidence bounded independently of raw dependency count', () => {
  const index = buildArchitectureEvidence(graph(Array.from({ length: 1000 }, (_, index) => edge(String(index), 'sa', index % 2 ? 'sb' : null))), 4);
  expect(index.relationships.length).toBeLessThanOrEqual(4);
  expect(index.omittedRelationships).toBeGreaterThanOrEqual(0);
  expect(serializeArchitectureEvidence(index).length).toBeLessThan(10_000);
});
