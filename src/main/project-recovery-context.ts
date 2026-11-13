import type { ChatThread, SourceEvidence } from '../shared/types';
import { chatEvidence } from './source-memory';
import { toolFailed } from './tool-outcome';

export function nextProjectAction(chat: ChatThread): string {
  const task = chat.projectHandoff;
  if (!task || task.needsCurrentRequirements || !task.requirements.length)
    return 'Initialize pending acceptance criteria for the current request using update_project_task; retain unfinished constraints.';
  if (task.taskPolicy?.intent === 'debug' && !task.taskPolicy.diagnosis?.executionConfirmed)
    return 'Run a relevant diagnostic with the known interpreter/process tools, then record_project_diagnosis using its current evidence ID. Source reads alone cannot satisfy diagnostic execution.';
  const step = chat.workPlan?.steps.find(item => item.status === 'in_progress') ?? chat.workPlan?.steps.find(item => item.status === 'pending');
  const requirement = task.requirements.find(item => !['completed', 'passed'].includes(item.status));
  return step ? `Advance the unfinished step: ${step.text.slice(0, 400)}. Reuse the validated source/revision context.`
    : requirement ? `Implement or verify the unfinished requirement: ${requirement.text.slice(0, 400)}. Use saved source context; do not restart exploration.`
      : 'Review the current task with read_project_task and add pending criteria for any unfinished current deliverables before claiming completion.';
}

/** Compact complete JSON with explicit omission counts; full records remain retrievable. */
export function projectRecoveryCheckpoint(chat: ChatThread, extra: SourceEvidence[] = [], objective?: string): string {
  const task = chat.projectHandoff;
  const active = task?.requirements.filter(item => !['completed', 'passed'].includes(item.status)) ?? [];
  const observations = [...chatEvidence(chat), ...extra];
  const sources: object[] = [];
  let interpreter: { evidenceId: string; tool: string; input: string } | undefined;
  for (const item of [...observations].reverse()) {
    let result: any;
    try { result = JSON.parse(item.result); } catch { continue; }
    if (toolFailed(result)) continue;
    if (item.tool === 'read_project_file' && sources.length < 4) {
      sources.push({ evidenceId: item.id, input: item.input.slice(0, 220), hash: result.hash, revision: result.revision,
        startLine: result.startLine, endLine: result.endLine, nextStartLine: result.nextStartLine, reuse: result.readReuse?.kind });
    }
    if (!interpreter && (item.tool === 'setup_project_python_environment' || item.tool === 'discover_project_python' ||
      (['run_project_command', 'run_project_process'].includes(item.tool) && result.exitCode === 0 && /python/i.test(item.input))))
      interpreter = { evidenceId: item.id, tool: item.tool, input: item.input.slice(0, 300) };
  }
  const request = objective ?? task?.taskPolicy?.request ?? task?.objective ?? chat.title;
  const checkpoint = {
    kind: 'MERCURY_RECOVERY_CHECKPOINT', objective: request.slice(0, 768), objectiveTruncated: request.length > 768,
    requestId: task?.taskPolicy?.requestId,
    nextAction: objective ? `Continue the assigned task within your original worker scope: ${objective.slice(0, 350)}. Reuse saved findings and report remaining limitations; do not repeat completed effects.` : nextProjectAction(chat),
    diagnosis: { accepted: task?.taskPolicy?.diagnosis?.executionConfirmed === true,
      message: task?.taskPolicy?.diagnosis?.executionConfirmed ? 'Diagnosis accepted; narrow edits may proceed subject to current tool permissions.' : 'Diagnostic execution has not been accepted.',
      affectedPaths: task?.taskPolicy?.diagnosis?.affectedPaths.slice(0, 4),
      omittedPaths: Math.max(0, (task?.taskPolicy?.diagnosis?.affectedPaths.length ?? 0) - 4) },
    requirements: active.slice(0, 8).map(item => ({ id: item.id, status: item.status, text: item.text.slice(0, 120), textTruncated: item.text.length > 120 })),
    omittedRequirements: Math.max(0, active.length - 8),
    blocker: task?.blocker ? { tool: task.blocker.tool, code: task.blocker.code, message: task.blocker.message.slice(0, 250) } : undefined,
    sources, omittedSourceReferences: Math.max(0, observations.filter(item => item.tool === 'read_project_file').length - sources.length), interpreter,
    retrieval: 'Use read_project_task for complete criteria, diagnosis and allowed paths; recall_context with evidenceId for exact inputs/results; read_chat_history for the complete user request. Excerpts are marked or bounded; they do not replace full records. Completed effects must not be replayed.',
  };
  // Drop optional source previews rather than cutting JSON or silently omitting requirements.
  while (JSON.stringify(checkpoint).length > 6000 && checkpoint.sources.length) { checkpoint.sources.pop(); checkpoint.omittedSourceReferences++; }
  if (JSON.stringify(checkpoint).length > 6000) checkpoint.requirements = checkpoint.requirements.map(item => ({ ...item, text: '', textTruncated: true }));
  return JSON.stringify(checkpoint);
}

export function projectBlockedExplanation(chat: ChatThread, reason: string): string {
  return `Work saved; the task is blocked because the model stopped making meaningful progress after recovery.\n\n${reason}\n\nNext action: ${nextProjectAction(chat)}\n\nCompleted changes and evidence are preserved. Unfinished work is not marked complete.`;
}
