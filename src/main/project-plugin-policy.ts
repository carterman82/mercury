import type { ProjectExecutionAdapter, ProjectExecutionRequest } from './project-execution';
export interface ProjectPluginPolicy {
  mode: 1 | 2 | 3;
  workspaceRoot: string;
  execution?: ProjectExecutionAdapter;
  authorize(details: string, request: ProjectExecutionRequest | null, signal: AbortSignal): Promise<void>;
}
