import type { ProjectHandoff, SourceEvidence } from '../shared/types';
import { toolFailed } from './tool-outcome';

function invokesTestRunner(args: any): boolean {
  const tokens: string[] = args.executable
    ? [args.executable, ...(args.args ?? [])]
    : (String(args.command ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
        token.replace(/^["']|["']$/g, ''),
      );
  const program = (tokens.shift() ?? '')
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase();
  if (tokens.some((token) => /^(?:--help|-h|--version|--dry-run)$/.test(token))) return false;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program))
    return /^(?:test|smoke)(?::|$)/.test(tokens[0] === 'run' ? (tokens[1] ?? '') : (tokens[0] ?? ''));
  if (program === 'node')
    return tokens.includes('--test') && !tokens.some((token) => ['-e', '--eval', '-p', '--print'].includes(token));
  if (['python', 'python3', 'py'].includes(program))
    return tokens[0] === '-m' && ['pytest', 'unittest'].includes(tokens[1]);
  if (['pytest', 'vitest', 'jest', 'ctest'].includes(program)) return true;
  return ['playwright', 'dotnet', 'cargo', 'go', 'mvn', 'gradle'].includes(program) && tokens[0] === 'test';
}

/** Delivery checks are host-owned; a prose claim or source inspection is not a test. */
export function hasCurrentProjectTest(handoff: ProjectHandoff, evidence: SourceEvidence[]): boolean {
  return evidence.some((item) => {
    if ((item.projectRevision ?? 0) !== (handoff.generation ?? 0) || item.at < (handoff.lastMutationAt ?? 0))
      return false;
    let result: any;
    let args: any;
    try {
      result = JSON.parse(item.result);
      args = JSON.parse(item.input);
    } catch {
      return false;
    }
    if (!result || toolFailed(result) || result.verificationUnknown || result.projectChange === 'unknown') return false;
    if (['run_project_command', 'run_project_process'].includes(item.tool)) {
      const command = String(args.executable ?? args.command ?? '');
      const checkRunner = invokesTestRunner(args);
      const observationOnly = /^\s*(?:echo|dir|ls|pwd|cat|type|git\s+status)\b/i.test(command);
      return result.exitCode === 0 && !observationOnly && (args.purpose === 'test' || checkRunner);
    }
    return (
      item.tool === 'browser_read' &&
      Boolean(
        handoff.browser?.interacted &&
        handoff.browser.observed &&
        !handoff.browser.errors?.length &&
        handoff.browser.observationId === item.id,
      )
    );
  });
}

export function projectDeliveryFeedback(
  handoff: ProjectHandoff,
  evidence: SourceEvidence[],
  mutated: boolean,
): string | undefined {
  if (!mutated && handoff.taskPolicy?.intent === 'answer') return;
  const pending = handoff.requirements.filter((item) => item.status !== 'passed');
  const missingCriteria = mutated && !handoff.requirements.length;
  const missingCompatibility = handoff.requiresModelVerification && !handoff.compatibility;
  const missingStages = handoff.requiresModelVerification
    ? ['page', 'model', 'inference'].filter(
        (stage) => !handoff.requirements.some((item) => item.stage === stage && item.verification === 'browser'),
      )
    : [];
  const needsTest = mutated && !hasCurrentProjectTest(handoff, evidence);
  const blockerResolved =
    handoff.blocker &&
    handoff.requirements.length > 0 &&
    !pending.length &&
    handoff.requirements.every(
      (requirement) =>
        requirement.evidenceIds.length > 0 &&
        requirement.evidenceIds.every((id) =>
          evidence.some(
            (item) =>
              item.id === id &&
              item.at > handoff.blocker!.at &&
              (item.projectRevision ?? 0) === (handoff.generation ?? 0) &&
              item.at >= (handoff.lastMutationAt ?? 0),
          ),
        ),
    );
  if (
    !pending.length &&
    !needsTest &&
    !missingCriteria &&
    !missingCompatibility &&
    !missingStages.length &&
    (!handoff.blocker || blockerResolved)
  )
    return;
  return `Delivery is not yet verified. Continue working with the offered tools before answering. Do not replay completed edits or weaken criteria.\n${JSON.stringify(
    {
      pending,
      needsTest,
      missingCriteria,
      missingCompatibility,
      missingStages,
      blocker: handoff.blocker,
      nextAction:
        missingCriteria || missingCompatibility || missingStages.length
          ? 'Call update_project_task to add the missing concrete acceptance criteria or documented model compatibility. Browser model work requires separate browser criteria with stage:page, stage:model (selector/expectedText), and stage:inference. Preserve existing criteria, then verify the added criteria.'
          : needsTest
            ? 'Run the relevant existing test suite and a smoke test of the changed behavior. Use purpose:"test" for a custom test command. Inspect output, fix failures, then cite the returned evidenceId in update_project_task. Source inspection, builds and lint alone do not establish tested behavior.'
            : 'Use read_project_task for exact criteria, reuse current successful evidence with update_project_task, and run any missing checks. If a previous approach failed, resolve the blocker using current successful verification.',
    },
  )}`;
}
