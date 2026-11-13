import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import type { ChatThread } from '../shared/types';
import { WorkPlanPanel } from './WorkPlanPanel';

const chat = (): ChatThread => ({ id: 'chat', title: 'Task', profile: { provider: 'ollama', model: 'test', contextLimit: 32000 }, messages: [], status: 'idle', updatedAt: 1 });
const plan = () => ({ revision: 3, origin: 'explicit' as const, objective: 'Improve project navigation', steps: [{ id: 'inspect', text: 'Inspect navigation', status: 'completed' as const }, { id: 'build', text: 'Build the sidebar', status: 'in_progress' as const }, { id: 'check', text: 'Check keyboard navigation', status: 'pending' as const }], updatedAt: 1 });
const render = (value: ChatThread, disabled = false) => new JSDOM(renderToStaticMarkup(<WorkPlanPanel chat={value} disabled={disabled} onImplement={() => {}} onExit={() => {}} onToggle={() => {}} />)).window.document;

it('does not add a card to chats without a saved plan or plan mode', () => {
  expect(render(chat()).body.innerHTML).toBe('');
});

it('lets the user leave plan mode before a proposal exists', () => {
  const value = { ...chat(), collaborationMode: 'plan' as const };
  const document = render(value);
  expect(document.body.textContent).toContain('Plan mode');
  expect(document.querySelector('button')?.textContent).toBe('Exit plan mode');
  expect([...document.querySelectorAll('button')].some(item => item.textContent === 'Implement plan')).toBe(false);
});

it('shows saved progress and the current step with editable execution checkboxes', () => {
  const document = render({ ...chat(), workPlan: plan() });
  expect(document.querySelector('summary')?.textContent).toContain('1 of 3 complete');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Build the sidebar');
  const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(checkboxes).toHaveLength(3);
  expect(checkboxes.map(item => item.checked)).toEqual([true, false, false]);
  expect(checkboxes.every(item => !item.disabled && item.closest('label')?.textContent?.trim())).toBe(true);
});

it('renders a reviewable proposal and disables checklist edits during planning', () => {
  const document = render({ ...chat(), collaborationMode: 'plan', workPlan: { ...plan(), proposal: '## Proposed navigation\n\nAdd **keyboard support**.' } });
  expect(document.querySelector('h2')?.textContent).toBe('Proposed navigation');
  expect(document.querySelector('strong')?.textContent).toBe('keyboard support');
  expect([...document.querySelectorAll('button')].map(item => item.textContent)).toContain('Implement plan');
  expect([...document.querySelectorAll<HTMLInputElement>('input')].every(item => item.disabled)).toBe(true);
});

it('blocks actions while a response or update is running', () => {
  const document = render({ ...chat(), collaborationMode: 'plan', workPlan: { ...plan(), proposal: 'The saved proposal.' } }, true);
  expect(document.querySelectorAll('button')).toHaveLength(2);
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(item => item.disabled)).toBe(true);
  const execution = render({ ...chat(), workPlan: plan() }, true);
  expect(execution.querySelectorAll('input')).toHaveLength(3);
  expect([...execution.querySelectorAll<HTMLInputElement>('input')].every(item => item.disabled)).toBe(true);
});

it('does not display automatic plans without user intervention', () => {
  const document = render({ ...chat(), workPlan: { ...plan(), origin: 'automatic', steps: [{ id: 'done', text: 'Update navigation', status: 'completed' }] } });
  expect(document.body.innerHTML).toBe('');
});

it('handles plan with missing steps array gracefully', () => {
  // This test simulates a malformed work plan that could cause crashes
  const chatWithMalformedPlan = {
    ...chat(),
    workPlan: { 
      revision: 1, 
      origin: 'explicit' as const, 
      objective: 'Test plan', 
      // steps is undefined or not an array - this could cause crashes
    } as ChatThread['workPlan']
  };
  const document = render(chatWithMalformedPlan);
  // Should not throw and should render something meaningful
  expect(document.body.innerHTML).toContain('Test plan');
});

it('handles automatic plan with missing steps gracefully', () => {
  // This test simulates an automatic plan that might cause the panel to return null
  const chatWithAutomaticPlan = {
    ...chat(),
    workPlan: { 
      revision: 1, 
      origin: 'automatic' as const, 
      objective: 'Auto plan', 
    } as ChatThread['workPlan']
  };
  const document = render(chatWithAutomaticPlan);
  // Automatic plans without planning mode should be hidden
  expect(document.body.innerHTML).toBe('');
});

it('handles work plan with undefined origin gracefully', () => {
  // This test simulates a work plan where origin might be missing
  const chatWithUndefinedOrigin = {
    ...chat(),
    workPlan: { 
      revision: 1, 
      objective: 'Plan without origin', 
      steps: [] as any,
    } as ChatThread['workPlan']
  };
  const document = render(chatWithUndefinedOrigin);
  // Should handle gracefully without crashing
  expect(document.body.innerHTML).toContain('Plan without origin');
});

it('handles empty steps array correctly', () => {
  const chatWithEmptySteps = {
    ...chat(),
    workPlan: { 
      revision: 1, 
      origin: 'explicit' as const, 
      objective: 'Plan with no steps', 
      steps: [], 
      updatedAt: 1
    } as ChatThread['workPlan']
  };
  const document = render(chatWithEmptySteps);
  // Should show the objective but no steps (no "Steps" summary since array is empty)
  expect(document.body.innerHTML).toContain('Plan with no steps');
  // For empty array, should show "All steps complete"
  expect(document.body.innerHTML).toContain('All steps complete');
});
