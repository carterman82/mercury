import { afterEach, expect, it, vi } from 'vitest';
import { newHandoff, projectTaskInstructions, projectTaskReadTool, projectTaskTool, readProjectTask, updateProjectTask } from './project-progress';

afterEach(() => vi.restoreAllMocks());
const criterion = (text: string) => ({ text, status: 'not_run', verification: 'inspection', evidenceIds: [] });

it('preserves the public task schemas, descriptions and instructions', () => {
  expect({ update: projectTaskTool, read: projectTaskReadTool, instructions: projectTaskInstructions }).toMatchSnapshot();
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
