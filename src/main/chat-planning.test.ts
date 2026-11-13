import { expect, it } from 'vitest';
import type { ChatThread } from '../shared/types';
import { advanceAutomaticPlan, assertPlanningToolAllowed, finalizePlanResponse, isSubstantialTask, parsePlanCommand, planContext, planningToolAllowed, seedAutomaticPlan, submitChatPlan, updateChatPlan } from './chat-planning';

const chat = (mode: 'plan' | 'default' = 'default') => ({ id: 'chat', collaborationMode: mode, messages: [], profile: { provider: 'ollama', model: 'test', contextLimit: 8192 }, title: 'Task', status: 'idle', updatedAt: 1 }) as ChatThread;
const plan = (value: ChatThread) => value.workPlan!;

it('parses only leading /plan commands and preserves inline task text', () => {
  expect(parsePlanCommand(' /plan ')).toEqual({ command: 'enter', prompt: '' });
  expect(parsePlanCommand('/plan Add search and tests')).toEqual({ command: 'enter', prompt: 'Add search and tests' });
  expect(parsePlanCommand('/PLAN off')).toEqual({ command: 'exit', prompt: '' });
  expect(parsePlanCommand('/planner rewrite')).toEqual({ command: null, prompt: '/planner rewrite' });
  expect(parsePlanCommand('Explain /plan')).toEqual({ command: null, prompt: 'Explain /plan' });
});

it('saves an explicit proposal without approving it and preserves unchanged step identities', () => {
  const value = chat('plan');
  submitChatPlan(value, { proposal: 'Review the design.', steps: ['Inspect source', 'Implement behavior'] });
  const id = plan(value).steps[0].id;
  expect(plan(value)).toMatchObject({ origin: 'explicit', revision: 1, proposal: 'Review the design.' });
  submitChatPlan(value, { proposal: 'Revised design.', steps: ['Inspect source', 'Implement behavior', 'Verify behavior'] });
  expect(plan(value).steps[0].id).toBe(id);
  expect(plan(value).revision).toBe(2);
  expect(value.collaborationMode).toBe('plan');
  expect(plan(value).steps.every(step => step.status === 'pending')).toBe(true);
  expect(() => submitChatPlan(chat(), { proposal: 'Plan', steps: ['Inspect'] })).toThrow();
});

it('updates a durable execution checklist independently of acceptance evidence', () => {
  const value = chat();
  const handoff = { requirements: [{ text: 'Keep evidence', status: 'passed', evidenceIds: ['e1'] }] };
  value.projectHandoff = handoff as ChatThread['projectHandoff'];
  updateChatPlan(value, { plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Implement', status: 'in_progress' }] });
  const id = plan(value).steps[0].id;
  updateChatPlan(value, { explanation: 'Implementation finished', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Implement', status: 'completed' }] });
  expect(plan(value).steps[0].id).toBe(id);
  expect(plan(value).revision).toBe(2);
  expect(value.projectHandoff).toBe(handoff);
  expect(handoff.requirements[0]).toEqual({ text: 'Keep evidence', status: 'passed', evidenceIds: ['e1'] });
  expect(() => updateChatPlan(chat('plan'), { plan: [{ step: 'Work', status: 'pending' }] })).toThrow();
  expect(() => updateChatPlan(value, { plan: [{ step: 'A', status: 'in_progress' }, { step: 'B', status: 'in_progress' }] })).toThrow();
  expect(() => updateChatPlan(value, { plan: [] })).toThrow();
});

it('detects substantive implementation from intent rather than message length', () => {
  expect(isSubstantialTask('Migrate authentication to OAuth')).toBe(true);
  expect(isSubstantialTask('Build a dashboard with filtering and export')).toBe(true);
  expect(isSubstantialTask('Can you implement search and add regression tests?')).toBe(true);
  expect(isSubstantialTask('Fix a typo in the heading')).toBe(false);
  expect(isSubstantialTask('Explain how the migration works')).toBe(false);
  expect(isSubstantialTask('What does this code do? '.repeat(100))).toBe(false);
});

it('seeds larger tasks once and retains unfinished plans across follow-ups', () => {
  const value = chat();
  seedAutomaticPlan(value, 'Migrate authentication to OAuth');
  expect(plan(value).steps).toHaveLength(3);
  expect(plan(value).origin).toBe('automatic');
  const before = structuredClone(plan(value));
  seedAutomaticPlan(value, 'Implement a dashboard with search and filtering');
  expect(value.workPlan).toEqual(before);
  const simple = chat();
  seedAutomaticPlan(simple, 'Fix a typo');
  expect(simple.workPlan).toBeUndefined();
  const planning = chat('plan');
  seedAutomaticPlan(planning, 'Migrate authentication to OAuth');
  expect(planning.workPlan).toBeUndefined();
});

it('supports host-detected growth without replacing an unfinished objective', () => {
  const value = chat();
  seedAutomaticPlan(value, 'Fix the heading', true);
  expect(plan(value).objective).toBe('Fix the heading');
  expect(plan(value).steps).toHaveLength(3);
  const before = structuredClone(plan(value));
  seedAutomaticPlan(value, 'A later implementation detail', true);
  expect(plan(value)).toEqual(before);
});

it('advances the default automatic checklist from actual host events and reopens verification after edits', () => {
  const value = chat();
  seedAutomaticPlan(value, 'Migrate authentication to OAuth');
  const initial = structuredClone(plan(value));
  advanceAutomaticPlan(value, 'test');
  expect(plan(value)).toEqual(initial);
  advanceAutomaticPlan(value, 'mutation');
  expect(plan(value).steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending']);
  const mutated = structuredClone(plan(value));
  advanceAutomaticPlan(value, 'mutation');
  expect(plan(value)).toEqual(mutated);
  advanceAutomaticPlan(value, 'test');
  expect(plan(value).steps.map(step => step.status)).toEqual(['completed', 'completed', 'in_progress']);
  advanceAutomaticPlan(value, 'completed');
  expect(plan(value).steps.every(step => step.status === 'completed')).toBe(true);
  expect(plan(value).revision).toBe(initial.revision + 3);
  const done = structuredClone(plan(value));
  advanceAutomaticPlan(value, 'completed');
  expect(plan(value)).toEqual(done);
  advanceAutomaticPlan(value, 'mutation');
  expect(plan(value).steps.map(step => step.status)).toEqual(['completed', 'in_progress', 'pending']);
  expect(plan(value).steps.map(step => step.id)).toEqual(initial.steps.map(step => step.id));
});

it('never auto-advances explicit proposals or customized model checklists', () => {
  const explicit = chat('plan');
  submitChatPlan(explicit, { proposal: 'Review design.', steps: ['Inspect', 'Implement'] });
  explicit.collaborationMode = 'default';
  const custom = chat();
  updateChatPlan(custom, { plan: [{ step: 'Custom work', status: 'in_progress' }] });
  for (const value of [explicit, custom]) {
    const before = structuredClone(plan(value));
    for (const event of ['mutation', 'test', 'completed'] as const) advanceAutomaticPlan(value, event);
    expect(plan(value)).toEqual(before);
  }
});

it('captures a proposed plan and derives steps while keeping explicit planning active', () => {
  const value = chat('plan');
  const text = '<proposed_plan>\n# Search\n- [ ] Inspect source\n- [ ] Add search\n- [ ] Verify results\n</proposed_plan>';
  expect(finalizePlanResponse(value, text)).toBe(text);
  expect(plan(value).proposal).toContain('# Search');
  expect(plan(value).steps.map(step => step.text)).toEqual(['Inspect source', 'Add search', 'Verify results']);
  expect(value.collaborationMode).toBe('plan');
  const ordinary = chat();
  finalizePlanResponse(ordinary, text);
  expect(ordinary.workPlan).toBeUndefined();
});

it('keeps explicitly submitted steps when the final proposal repeats them', () => {
  const value = chat('plan');
  submitChatPlan(value, { proposal: '# Proposal\n- A supporting detail', steps: ['Implement the design', 'Verify behavior'] });
  const before = structuredClone(plan(value));
  finalizePlanResponse(value, '<proposed_plan>\n# Proposal\n- A supporting detail\n</proposed_plan>');
  expect(plan(value)).toEqual(before);
});

it('allows exploration and confined diagnostics but refuses implementation capabilities', () => {
  for (const name of ['read_project_file', 'search_project_files', 'web_search', 'submit_plan', 'wait_project_tasks', 'review_project_task', 'accept_project_task']) expect(planningToolAllowed(name, {})).toBe(true);
  expect(planningToolAllowed('start_project_task', { kind: 'investigation' })).toBe(true);
  expect(planningToolAllowed('start_project_task', { kind: 'review' })).toBe(true);
  expect(planningToolAllowed('start_project_task', { kind: 'implementation' })).toBe(false);
  expect(planningToolAllowed('start_project_task', { kind: 'testing' })).toBe(false);
  expect(planningToolAllowed('run_project_command', { command: 'npm test', purpose: 'test' })).toBe(true);
  expect(planningToolAllowed('run_project_process', { executable: 'node', args: ['script.js'], filesystemAccess: 'read-only' })).toBe(true);
  for (const args of [{ writePaths: ['src'] }, { filesystemAccess: 'workspace-write' }, { network: 'allow' }, { sandboxPermissions: 'require_escalated' }]) expect(planningToolAllowed('run_project_command', args)).toBe(false);
  for (const name of ['patch_project_file', 'setup_project_python_environment', 'invoke_plugin', 'browser_fill', 'update_plan', 'complete_project_requirements', 'integrate_project_changes', 'unknown_tool']) expect(planningToolAllowed(name, {})).toBe(false);
  expect(() => assertPlanningToolAllowed(chat('plan'), 'edit_project_file', {})).toThrow(expect.objectContaining({ code: 'PLAN_MODE_READ_ONLY' }));
  expect(() => assertPlanningToolAllowed(chat(), 'edit_project_file', {})).not.toThrow();
});

it('bounds persisted plan context while retaining mode and checklist state', () => {
  const value = chat('plan');
  submitChatPlan(value, { proposal: 'P'.repeat(16000), steps: ['Inspect', 'Verify'] });
  const context = planContext(value);
  expect(context).toContain('plan');
  expect(context).toContain('Inspect');
  expect(context.length).toBeLessThanOrEqual(20000);
});

it('rejects invalid proposals atomically and bounds escaped plan context as valid JSON', () => {
  const value = chat('plan');
  submitChatPlan(value, { proposal: '\\'.repeat(16000), steps: Array.from({ length: 20 }, (_, i) => `${i}: ${'\\'.repeat(490)}`) });
  const before = structuredClone(value.workPlan);
  expect(() => submitChatPlan(value, { proposal: 'Invalid replacement', steps: [] })).toThrow();
  expect(() => submitChatPlan(value, { proposal: 'P'.repeat(16001), steps: ['Inspect'] })).toThrow();
  expect(value.workPlan).toEqual(before);
  const context = planContext(value);
  expect(context.length).toBeLessThanOrEqual(20000);
  expect(JSON.parse(context).workPlan.steps).toHaveLength(20);
});
