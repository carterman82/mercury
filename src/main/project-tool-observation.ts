import type { ChatMessage, ChatThread } from '../shared/types';
import { sourceEvidence } from './source-memory';
import { toolFailed, toolFailureCode } from './tool-outcome';
import { ProjectStalledError, projectActionIdentity, resolvesHandoffBlocker, type ProjectProgress } from './project-recovery';
import { recordProjectAction } from './project-handoff';

interface ProjectToolObservation {
  chat: ChatThread;
  response: ChatMessage;
  call: { name: string; arguments?: unknown };
  attempt?: { validationError?: unknown };
  output: unknown;
  activity: NonNullable<ChatMessage['toolActivity']>[number];
  progress: ProjectProgress;
  observedGeneration: number;
  performedMutation: boolean;
  getGeneration: () => number;
  notice: (message: string) => void;
  onStall: (error: ProjectStalledError) => void;
}

/** Preserve observation order: failures, evidence, generation, handoff, recovery.
 * ChatService retains persistence, abort ownership and tool transport. */
export function observeProjectTool(input: ProjectToolObservation) {
  const { chat, response, call, attempt, activity, progress, getGeneration, notice, onStall } = input;
  let { output, observedGeneration, performedMutation } = input;
  const providedArgs = (call.arguments ?? {}) as any;
  const args = call.name === 'setup_project_python_environment'
    ? { ...providedArgs, environmentPath: providedArgs.environmentPath ?? '.venv_test' } : providedArgs;
  const validationFailure = Boolean(attempt?.validationError);
  const knownRead = [...(chat.projectHandoff!.snapshots ?? []), ...chat.projectHandoff!.reads].find(item => item.path === (args.path ?? args.destination));
  // The SDK has already returned malformed arguments to the model as a
  // tool error.  Do not turn that zero-effect validation failure into a
  // persistent project blocker: the model may correct it, and a
  // read-only answer can still be complete without the bad call.
  if (toolFailed(output) && !validationFailure) {
    output = { ...(output as object), code: toolFailureCode(output), sourceRevision: (output as any)?.sourceRevision ?? knownRead?.hash ?? 'unknown' };
    activity.result=JSON.stringify(output).slice(0,16000);
    chat.projectHandoff!.blocker = { tool: call.name, target: String(args.path ?? args.destination ?? args.environmentPath ?? args.cwd ?? '.'), code: String((output as any).code ?? 'COMMAND_FAILED'), sourceRevision: (output as any)?.sourceRevision, message: String((output as any).error ?? (output as any).output ?? 'Failed action').slice(0, 1200), nextAction: typeof (output as any)?.nextAction === 'string' ? (output as any).nextAction : 'Resolve this blocker with a different approach; do not repeat the failed attempt.', at: Date.now() };
    const blocker=chat.projectHandoff!.blocker;
    blocker.action=projectActionIdentity(call.name,args,blocker.code);
    chat.projectHandoff!.failedApproaches=[...(chat.projectHandoff!.failedApproaches??[]),{tool:blocker.tool,target:blocker.target,code:blocker.code,input:JSON.stringify(call.arguments).slice(0,1600),sourceRevision:blocker.sourceRevision,message:blocker.message,at:blocker.at}].slice(-30);
  } else if (chat.projectHandoff!.blocker) {
    const blocker=chat.projectHandoff!.blocker,target=String(args.path ?? args.destination ?? args.environmentPath ?? args.cwd ?? '.');
    // Reuse the exact recorded failed attempt; a truncated input cannot grant a
    // recovery route. No additional persisted blocker schema is needed.
    const failed = chat.projectHandoff!.failedApproaches?.slice().reverse().find(item => item.at === blocker.at && item.tool === blocker.tool && item.code === blocker.code && item.target === blocker.target);
    let failedArgs: unknown;
    try { failedArgs = failed && JSON.parse(failed.input); } catch { /* Incomplete history is not recovery evidence. */ }
    if (resolvesHandoffBlocker(blocker, call.name, args, target, output, failedArgs)) chat.projectHandoff!.blocker = undefined;
  }
  // All verification evidence, including commands, gets a stable reference.
  const evidence = sourceEvidence(call.name, call.arguments, output);
  (response.sourceEvidence ??= []).push(evidence);
  const generation = getGeneration();
  if (generation !== observedGeneration) performedMutation = true;
  if (generation !== observedGeneration && toolFailed(output)) output = { ...(output as object), verificationUnknown: true };
  if (generation !== observedGeneration && (output as any)?.projectChange !== 'unknown' && ['run_project_command', 'run_project_process', 'setup_project_python_environment'].includes(call.name)) output = { ...(output as object), projectChanged: true };
  if (generation !== observedGeneration && !['edit_project_file', 'patch_project_file', 'run_project_command', 'run_project_process', 'download_project_asset', 'setup_project_python_environment'].includes(call.name))
    recordProjectAction(chat.projectHandoff!, 'run_project_command', { command: 'Shared project changes (worker or another chat)' }, { projectChanged: true }, undefined, evidence.at);
  observedGeneration = generation;
  recordProjectAction(chat.projectHandoff!, call.name, call.arguments, output, evidence.id, evidence.at);
  evidence.projectRevision = chat.projectHandoff!.generation ?? 0;
  try {
    const recovery = progress.observe(call.name, call.arguments, output);
    if (recovery) {
      notice('Repeated work detected. Trying one different approach.');
      output = { ...(output as object), recovery, handoff: chat.projectHandoff };
      response.metrics!.recoveries = progress.recoveries;
    }
  } catch (error) {
    if (error instanceof ProjectStalledError) { onStall(error); }
    throw error;
  }
  output = { ...(output as object), evidenceId: evidence.id };
  return { output, observedGeneration, performedMutation };
}
