export type DependencyLanguage =
  'typescript' | 'javascript' | 'python' | 'java' | 'csharp' | 'go' | 'rust' | 'c' | 'cpp' | 'configuration';
export type DependencyConfidence = 'confirmed' | 'inferred' | 'unresolved';
export interface DependencyLocation {
  file: string;
  line: number;
  column: number;
}
export interface DependencySymbol extends DependencyLocation {
  id: string;
  name: string;
  qualifiedName: string;
  owner?: string;
  kind: 'function' | 'method' | 'constructor' | 'class';
  endLine: number;
}
export interface DependencyFile {
  id: string;
  path: string;
  language: DependencyLanguage;
  fingerprint: string;
}
export interface DependencyEdge extends DependencyLocation {
  id: string;
  kind: 'imports' | 'calls' | 'configuration';
  from: string;
  to: string | null;
  label: string;
  confidence: DependencyConfidence;
  reason?: string;
}
export interface DependencyDiagnostic {
  file?: string;
  message: string;
}
export interface ProjectDependencyGraph {
  schemaVersion: 1;
  analyzerVersion: string;
  sourceFingerprint: string;
  files: DependencyFile[];
  symbols: DependencySymbol[];
  edges: DependencyEdge[];
  diagnostics: DependencyDiagnostic[];
  coverage: {
    languages: DependencyLanguage[];
    parsedFiles: number;
    totalFiles: number;
    truncated: boolean;
    unresolvedReferences: number;
  };
}
export interface MapSource {
  path: string;
  absolute: string;
  language: DependencyLanguage;
  content: string;
  fingerprint: string;
}
export interface RawImport extends DependencyLocation {
  source: string;
  names: { local: string; imported: string }[];
  resolvedFiles?: string[];
}
export interface RawCall extends DependencyLocation {
  expression: string;
  name: string;
  receiver?: string;
  caller: string;
  target?: string;
  confidence?: DependencyConfidence;
  reason?: string;
}
export interface AnalyzedSource {
  path: string;
  symbols: DependencySymbol[];
  imports: RawImport[];
  calls: RawCall[];
  diagnostics: DependencyDiagnostic[];
  moduleName?: string;
}
