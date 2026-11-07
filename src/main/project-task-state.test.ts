import { afterEach, expect, it, vi } from 'vitest';
import { newHandoff, projectTaskInstructions, projectTaskReadTool, projectTaskTool, readProjectTask, updateProjectTask } from './project-progress';
import { completeProjectRequirements, projectTaskCompleteTool } from './project-task-state';
import { recordProjectAction } from './project-handoff';

afterEach(() => vi.restoreAllMocks());
const criterion = (text: string) => ({ text, status: 'not_run', verification: 'inspection', evidenceIds: [] });

it('preserves the public task schemas, descriptions and instructions', () => {
  expect({ update: projectTaskTool, read: projectTaskReadTool, complete: projectTaskCompleteTool, instructions: projectTaskInstructions }).toMatchSnapshot();
});

it('checks off selected IDs without evidence and reopens them after an edit', () => {
  const handoff = newHandoff(undefined, 'Implement both features');
  updateProjectTask(handoff, { requirements: [criterion('First'), criterion('Second')], remaining: 'Implement' }, []);
  const [first, second] = structuredClone(handoff.requirements);
  completeProjectRequirements(handoff, { requirementIds: [first.id], note: 'First feature implemented; runtime unavailable.' });
  expect(handoff.requirements[0]).toEqual({ ...first, status: 'completed', completionNote: 'First feature implemented; runtime unavailable.' });
  expect(handoff.requirements[1]).toEqual(second);
  expect(handoff.remaining).toBe('Implement');
  completeProjectRequirements(handoff, { requirementIds: [second.id], note: 'Second feature implemented.' });
  expect(handoff.remaining).toBe('');
  recordProjectAction(handoff, 'patch_project_file', { path: 'app.ts' }, { path: 'app.ts', hash: 'changed' });
  expect(handoff.requirements.every(item => item.status === 'not_run' && !item.completionNote)).toBe(true);
});

it('rejects unknown IDs and malformed completions atomically', () => {
  const handoff = newHandoff(undefined, 'Keep scope');
  updateProjectTask(handoff, { requirements: [criterion('First')], remaining: 'Implement' }, []);
  const before = structuredClone(handoff);
  for (const raw of [
    { requirementIds: [handoff.requirements[0].id, 'unknown'], note: 'Done' },
    { requirementIds: [], note: 'Done' },
    { requirementIds: [handoff.requirements[0].id], note: ' ' },
    { requirementIds: [handoff.requirements[0].id], note: 'Done', extra: true },
  ]) expect(() => completeProjectRequirements(handoff, raw)).toThrow();
  expect(handoff).toEqual(before);
});

it('preserves verified results when a completion batch includes already-passed IDs', () => {
  const handoff = newHandoff(undefined, 'Finish both');
  updateProjectTask(handoff, { requirements: [criterion('Verified'), criterion('Implemented')], remaining: 'Finish' }, []);
  handoff.requirements[0].status = 'passed';
  handoff.requirements[0].evidenceIds = ['actual-check'];
  const verified = structuredClone(handoff.requirements[0]);
  completeProjectRequirements(handoff, { requirementIds: handoff.requirements.map(item => item.id), note: 'Implemented; remaining runtime check unavailable.' });
  expect(handoff.requirements[0]).toEqual(verified);
  expect(handoff.requirements[1].status).toBe('completed');
});

it('retains omitted criteria and IDs across partial updates and metadata-only updates', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const handoff = newHandoff(undefined, 'Ship both features');
  updateProjectTask(handoff, { requirements: [criterion('First'), criterion('Second')], remaining: 'Implement' }, []);
  const first = structuredClone(handoff.requirements[0]);
  const second = structuredClone(handoff.requirements[1]);
  updateProjectTask(handoff, { requirements: [{ ...second, status: 'blocked' }], remaining: 'Resolve blocker' }, []);
  updateProjectTask(handoff, { requirements: [], remaining: 'Continue' }, []);
  expect(readProjectTask(handoff)).toMatchObject({ objective: 'Ship both features', remaining: 'Continue', requirements: [first, { ...second, status: 'blocked' }] });
});

it('rejects reworded criteria and unknown schema fields without changing saved state', () => {
  const handoff = newHandoff(undefined, 'Keep scope');
  updateProjectTask(handoff, { requirements: [criterion('Original')], remaining: 'Implement' }, []);
  const before = structuredClone(handoff);
  expect(() => updateProjectTask(handoff, { requirements: [{ ...handoff.requirements[0], text: 'Weakened' }], remaining: '' }, [])).toThrow(expect.objectContaining({ code: 'REQUIREMENT_CHANGED' }));
  for (const raw of [
    { requirements: [], remaining: '', extra: true },
    { requirements: [{ ...criterion('New'), extra: true }], remaining: '' },
  ]) expect(() => updateProjectTask(handoff, raw, [])).toThrow(expect.objectContaining({ name: 'ZodError' }));
  expect(handoff).toEqual(before);
});

it('treats explicit empty requirements as a remaining-work update without resetting saved verification', () => {
  const handoff = newHandoff(undefined, 'Keep both acceptance criteria');
  updateProjectTask(handoff, { requirements: [criterion('First'), criterion('Second')], remaining: 'Build' }, []);
  // Existing verification and blockers survive a metadata-only domain update.
  handoff.requirements[0].status = 'passed';
  handoff.requirements[0].evidenceIds = ['saved-success'];
  handoff.requirements[1].status = 'blocked';
  handoff.generation = 3;
  handoff.lastMutationAt = 100;
  const before = structuredClone(handoff.requirements);
  updateProjectTask(handoff, { requirements: [], remaining: 'Resolve the second criterion' }, []);
  expect(handoff.requirements).toEqual(before);
  expect(handoff).toMatchObject({ objective: 'Keep both acceptance criteria', generation: 3, lastMutationAt: 100, remaining: 'Resolve the second criterion' });
});
