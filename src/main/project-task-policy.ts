import path from 'node:path';
import { z } from 'zod';
import type { ProjectHandoff, SourceEvidence, ProjectTaskPolicy } from '../shared/types';
import { ToolFailure } from './tool-outcome';

export type { ProjectTaskPolicy } from '../shared/types';

export function beginProjectRequest(previous: ProjectTaskPolicy | undefined, request: string, requestId: string): ProjectTaskPolicy {
  const resume = /^\s*(?:sorry[,\s]*)?(?:resume|continue|carry on|keep going)[.!\s]*$/i.test(request);
  const text = resume && previous ? previous.request : request;
  const readOnly = /(?:do not|don't|without)\s+(?:implement|edit|change)|\bread.only\b/i.test(text);
  const answer = readOnly || (/\b(?:why|what|explain|status|summari[sz]e|overview|analy[sz]e|evaluate|suggest|read|list|inspect|show)\b/i.test(text) && !/\b(?:fix|implement|apply|modify|rewrite|refactor|create|add|install|make the changes)\b/i.test(text));
  const debug = !answer && /\b(?:debug|fix|bug|regression|broken|fails?|failing)\b/i.test(text);
  const setup = !answer && !debug && /\b(?:install|set up|setup|prepare)\b.{0,100}\b(?:pytest|requests|dependencies|environment|venv|packages)\b/i.test(text) && !/\b(?:rewrite|implement|refactor|modify|source code)\b/i.test(text);
  return { requestId, request: text, intent: answer ? 'answer' : setup ? 'setup' : debug ? 'debug' : 'implementation',
    backendChangeRequested: !readOnly && !/(?:do not|don't|never)\s+(?:add|use|replace|switch|implement|enable)/i.test(text) && /\b(?:add|use|replace|switch|implement|enable)\b.{0,90}\b(?:fallback|another backend|gpt4all|alternative model|different backend)\b/i.test(text),
    runtimeInstallRequested: /\binstall\s+(?:a\s+|new\s+|real\s+)?(?:python|node(?:\.js)?|uv|dotnet|\.net|java)\b/i.test(text) && !/\b(?:existing|already installed|do not install|don't install)\b/i.test(text) };
}

export const diagnosisSchema = z.object({
  symptom: z.string().min(1).max(2000), hypothesis: z.string().min(1).max(3000),
  testToConfirm: z.string().min(1).max(2000), proposedChange: z.string().min(1).max(3000),
  affectedPaths: z.array(z.string().min(1).max(500).refine(value => !path.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '..' || part === '.git'))).min(1).max(30),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(20),
}).strict();
const { $schema: _schema, ...diagnosisParameters } = z.toJSONSchema(diagnosisSchema);
export const diagnosisTool = { type: 'function', function: { name: 'record_project_diagnosis',
  description: 'Before debugging source edits, record the observed symptom, hypothesis (not an established fact), exact current evidenceIds, affected project paths, proposed narrow change and testToConfirm. At least one actual diagnostic command or probe_project_endpoint output is required for edit authorization. Failed diagnostic executions can be evidence; denied/unrun calls cannot. Preserve the selected backend; alternative backend/download changes require separate review.',
  parameters: diagnosisParameters } };

export function recordProjectDiagnosis(handoff: ProjectHandoff, raw: unknown, evidence: SourceEvidence[]) {
  const value = diagnosisSchema.parse(raw);
  const policy = handoff.taskPolicy;
  if (!policy) throw new ToolFailure('TASK_POLICY_REQUIRED', 'A current user request is required.');
  const observations = value.evidenceIds.map(id => evidence.find(item => item.id === id));
  if (observations.some(item => !item || (item.projectRevision ?? 0) !== (handoff.generation ?? 0) || item.at < (handoff.lastMutationAt ?? 0)))
    throw new ToolFailure('DIAGNOSIS_EVIDENCE_STALE', 'Use exact current evidence IDs from observations after the latest source change.');
  const executionConfirmed = observations.some(item => {
    let result: any; try { result = JSON.parse(item!.result); } catch { return false; }
    return Boolean(result && ((item!.tool === 'probe_project_endpoint' && result.ran === true) ||
      (['run_project_command', 'run_project_process'].includes(item!.tool) && 'exitCode' in result && typeof result.output === 'string' && result.output.trim() && !result.verificationUnknown)));
  });
  policy.diagnosis = { ...value, at: Date.now(), revision: handoff.generation ?? 0, executionConfirmed };
  return { recorded: true, executionConfirmed, hypothesisVerified: false,
    nextAction: executionConfirmed ? 'Apply the narrow proposed change only within affectedPaths. These observations support a hypothesis, not proof of its cause. Preserve the selected backend; test the original failing path after edits.' : 'An actual diagnostic execution is still required before debugging edits. Run an approved diagnostic command or probe_project_endpoint; a source read alone does not establish a runtime failure.' };
}

export function requireDiagnosisForEdit(handoff: ProjectHandoff | undefined, relative?: string) {
  const policy = handoff?.taskPolicy;
  if (!policy) return; // Compatibility for host integrations without a model turn.
  if (policy.intent === 'answer' || policy.intent === 'setup') throw new ToolFailure('TASK_SCOPE_EDIT_BLOCKED', `This ${policy.intent} request does not authorize application source rewrites. Explain the proposed scope change and wait for a user implementation request.`);
  if (policy.intent !== 'debug') return;
  const diagnosis = policy.diagnosis;
  if (!diagnosis?.executionConfirmed) throw new ToolFailure('DIAGNOSIS_REQUIRED', 'Before debugging edits, record_project_diagnosis must cite output from an actual diagnostic command or endpoint probe. Reads and diagnostics remain available; do not invent a cause or replace the backend.', { nextAction: 'Probe the original failing behavior, then record symptom, hypothesis, evidenceIds, testToConfirm, affectedPaths and proposedChange. If execution is blocked, return a full explanation with that limitation.' });
  if (relative && !diagnosis.affectedPaths.some(file => relative === file || relative.startsWith(file.replace(/\/$/, '') + '/')))
    throw new ToolFailure('DIAGNOSIS_PATH_REQUIRED', 'This file is outside the recorded narrow diagnosis. Inspect it and amend the diagnosis with current evidence before changing it.');
}

/** Compare changes; existing backend references do not block unrelated fixes. */
export function backendScopeReason(policy: ProjectTaskPolicy | undefined, before: string, after: string): string | undefined {
  if (!policy || policy.backendChangeRequested) return;
  const markers = /\b(?:gpt4all|GPT4All|llama_cpp|llama-cpp-python|ollama\.pull|snapshot_download|hf_hub_download|generate_with_local_model)\b/g;
  const prior = new Set(before.match(markers) ?? []);
  const added = [...new Set(after.match(markers) ?? [])].filter(value => !prior.has(value));
  if (added.length) return `This change adds an alternative model backend/download (${added.join(', ')}), beyond the selected backend. Review this concrete scope expansion before writing it.`;
  const endpoints = (text: string) => [...text.matchAll(/(?:https?:\/\/[^\s'"`]+|(?:QWEN|MODEL|LLM)_(?:URL|MODEL|ENDPOINT)\s*=\s*[^\r\n]+)/g)].map(match => match[0]);
  if (policy.intent === 'debug' && endpoints(before).some(value => !endpoints(after).includes(value)))
    return 'This debugging change alters an existing model/endpoint selection. Review the exact change before replacing the selected configuration.';
}

export function runtimeInstallation(command: string) {
  return /\b(?:winget|choco|scoop|brew|apt(?:-get)?|dnf|yum)\b[^\r\n;&|]*\binstall\b[^\r\n;&|]*\b(?:python|nodejs|node|dotnet|openjdk|java)\b|\buv\s+python\s+install\b|\bpy\s+install\b/i.test(command);
}

export function enforceCommandTaskScope(policy: ProjectTaskPolicy | undefined, command: string, purpose?: string) {
  if (policy?.intent === 'setup' && purpose !== 'test') throw new ToolFailure('SETUP_TOOL_REQUIRED', 'Use the bounded environment setup tool for this dependency setup request. Only read-only confined test commands may run separately; request a separate implementation task for source changes.');
  if (runtimeInstallation(command) && !policy?.runtimeInstallRequested) throw new ToolFailure('RUNTIME_INSTALL_NOT_REQUESTED', 'This request does not authorize installing a new language runtime. Discover existing interpreters first; ask the user explicitly before a runtime installation.');
}
