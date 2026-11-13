import type { ProjectHandoff } from '../shared/types';
import { toolFailed } from './tool-outcome';
import { browserEvidenceKind } from './browser-tool-registry';

export function newHandoff(previous: ProjectHandoff | undefined, request: string): ProjectHandoff {
  return {
    ...(previous?.executionPolicy ? { executionPolicy: previous.executionPolicy } : {}),
    ...(previous?.needsCurrentRequirements !== undefined ? { needsCurrentRequirements: previous.needsCurrentRequirements } : {}),
    ...(previous?.retiredRequirements ? { retiredRequirements: previous.retiredRequirements } : {}),
    ...(previous?.retiredWorkPlans ? { retiredWorkPlans: previous.retiredWorkPlans } : {}),
    objective: previous?.objective ?? request.slice(0, 4000),
    requiresModelVerification: previous?.verificationTarget?.kind === 'browser_model',
    verificationTarget: previous?.verificationTarget,
    compatibility: previous?.compatibility,
    generation: previous?.generation,
    snapshots: previous?.snapshots,
    requirements: previous?.requirements ?? [],
    reads: previous?.reads ?? [],
    changedPaths: previous?.changedPaths ?? [],
    checks: previous?.checks ?? [],
    completedSteps: previous?.completedSteps ?? [],
    remaining: request.slice(0, 4000),
    updatedAt: Date.now(),
  };
}

export function recordProjectAction(
  handoff: ProjectHandoff,
  name: string,
  args: any,
  result: any,
  evidenceId?: string,
  at = Date.now(),
) {
  handoff.updatedAt = at;
  if (['read_project_record', 'list_project_records'].includes(name) && !toolFailed(result)) {
    handoff.snapshots = [...(handoff.snapshots ?? []).filter(item => item.path !== args.path), { path: args.path, hash: result.hash }].slice(-100);
  }
  if (name === 'read_project_file' && !toolFailed(result)) {
    handoff.reads = [
      ...handoff.reads.filter(
        (read) => read.path !== args.path || read.startLine !== (result.startLine ?? args.start ?? 1),
      ),
      {
        path: args.path,
        hash: result.hash,
        startLine: result.startLine ?? args.start ?? 1,
        endLine: result.endLine ?? args.end ?? 200,
      },
    ].slice(-50);
  }
  const mutation =
    (['patch_project_file', 'patch_project_record', 'edit_project_file', 'download_project_asset'].includes(name) && !toolFailed(result)) ||
    (['run_project_command', 'run_project_process', 'setup_project_python_environment'].includes(name) && result.projectChanged === true);
  if (mutation || result?.verificationUnknown) {
    if (result.path && result.hash) {
      handoff.reads = handoff.reads.filter((read) => read.path !== args.path);
      handoff.snapshots = [
        ...(handoff.snapshots ?? []).filter((item) => item.path !== result.path),
        { path: result.path, hash: result.hash },
      ].slice(-100);
    }
    if (result.path) handoff.changedPaths = [...new Set([...handoff.changedPaths, result.path])].slice(-100);
    handoff.lastMutationAt = at;
    handoff.generation = (handoff.generation ?? 0) + 1;
    // Prior browser observations cannot verify a new revision.
    handoff.browser = undefined;
    for (const requirement of handoff.requirements) if (requirement.status === 'passed' || requirement.status === 'completed') { requirement.status = 'not_run'; delete requirement.completionNote; }
    if (!toolFailed(result) && mutation)
      handoff.completedSteps = [
        ...handoff.completedSteps,
        `${name}: ${result.path ?? result.environmentPath ?? args.environmentPath ?? args.command ?? args.executable}`.slice(0, 300),
      ].slice(-30);
  }
  if (['run_project_command', 'run_project_process'].includes(name))
    handoff.checks = [
      ...handoff.checks,
      {
        name: String(args.command ?? args.executable).slice(0, 500),
        status: toolFailed(result) ? ('failed' as const) : ('passed' as const),
        at: Date.now(),
        evidenceId,
      },
    ].slice(-40);
  if (name.startsWith('browser_') && !toolFailed(result)) {
    const evidenceKind = browserEvidenceKind(name);
    if (evidenceKind === 'open')
      handoff.browser = {
        url: result.url,
        openedAt: at,
        interacted: false,
        observed: false,
        observationId: evidenceId,
      };
    if (handoff.browser && evidenceKind === 'interaction') {
      handoff.browser.interacted = true;
      handoff.browser.interactedAt = at;
      handoff.browser.observed = false;
      handoff.browser.observationId = undefined;
      handoff.browser.readyAtInteraction = handoff.browser.modelReady;
      if (name === 'browser_fill') {
        handoff.browser.submitted = result.submitted === true;
        handoff.browser.responseSelector = result.responseSelector;
        handoff.browser.replyBefore = result.replyBefore;
        handoff.browser.replyAfter = undefined;
      }
    }
    if (
      handoff.browser?.interacted &&
      evidenceKind === 'observation' &&
      result.url === handoff.browser.url
    ) {
      handoff.browser.observed = true;
      handoff.browser.observationId = evidenceId;
    }
    if (handoff.browser && result.errors) handoff.browser.errors = result.errors;
    if (handoff.browser && result.selected) {
      handoff.browser.selected = result.selected;
      if (!handoff.browser.interacted && name === 'browser_read') handoff.browser.observationId = evidenceId;
      if (result.selected.selector === handoff.browser.responseSelector)
        handoff.browser.replyAfter = result.selected.text;
    }
  }
}
