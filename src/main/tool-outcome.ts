/** One definition of failure for model tools, persisted activity and recovery. */
export class ToolFailure extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export function toolFailed(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return Boolean(result.error || result.isError || result.timedOut) ||
    ('exitCode' in result && result.exitCode !== 0);
}

export function toolFailureCode(value: unknown): string {
  const result = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof result.code === 'string') return result.code;
  if (result.timedOut) return 'COMMAND_TIMEOUT';
  const output=String(result.output ?? result.error ?? '');
  if (/SyntaxError|Expected unicode escape|Unterminated/.test(output)) return 'SCRIPT_SYNTAX';
  if (/not recognized|command not found/.test(output)) return 'SHELL_COMMAND_UNAVAILABLE';
  return 'exitCode' in result ? 'COMMAND_EXIT_'+result.exitCode : 'TOOL_ERROR';
}

export function toolError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: { path?: unknown[] }[] }).issues;
    const revisionIssue = Array.isArray(issues) && issues.some(issue => issue.path?.some(field => field === 'revision' || field === 'expectedHash'));
    return `Invalid tool arguments: ${JSON.stringify(issues)}. No action was executed. Correct the listed fields using the tool schema.${revisionIssue ? ' For existing files copy revision tokens exactly from read_project_file; for a new file pass expectedHash:null and omit revision. Use patch_project_file for partial edits.' : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function failedToolResult(error: unknown): { error: string; isError: true; code: string; [key: string]: unknown } {
  const message = toolError(error);
  const code = error instanceof ToolFailure ? error.code : error && typeof error === 'object' && 'issues' in error ? 'INVALID_ARGUMENTS' :
    /File changed since/.test(message) ? 'STALE_REVISION' : /exactly one occurrence/.test(message) ? 'PATCH_NO_MATCH' :
    /Unknown read revision/.test(message) ? 'UNKNOWN_REVISION' : /permission|denied|approval/i.test(message) ? 'ACCESS_BLOCKED' : 'TOOL_ERROR';
  return { error: message, isError: true, code, ...(error instanceof ToolFailure ? error.details : {}) };
}
