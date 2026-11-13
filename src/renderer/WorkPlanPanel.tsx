import React from 'react';
import type { ChatThread } from '../shared/types';
import { Markdown } from './Markdown';
import './WorkPlanPanel.css';

interface WorkPlanPanelProps {
  chat: ChatThread;
  disabled: boolean;
  onImplement: (revision: number) => void;
  onExit: () => void;
  onToggle: (stepId: string, completed: boolean, revision: number) => void;
}

export function WorkPlanPanel({ chat, disabled, onImplement, onExit, onToggle }: WorkPlanPanelProps) {
  const planning = chat.collaborationMode === 'plan';
  const plan = chat.workPlan;
  
  // Only show explicit plans (user-initiated), not automatic/auto-generated ones
  if (!planning && !plan) return null;
  if (plan?.origin === 'automatic' && !planning) return null;
  
  // Ensure steps is always an array to prevent crashes
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const completed = steps.filter(step => step.status === 'completed').length ?? 0;
  const active = steps.find(step => step.status === 'in_progress');
  const next = steps.find(step => step.status === 'pending');
  const proposal = planning && plan?.proposal?.trim();

  return <section className="work-plan-panel" aria-label={planning ? 'Plan mode' : 'Saved work plan'}>
    <div className="work-plan-heading"><span>{planning ? 'Plan mode' : 'Work plan'}</span>{planning && <button type="button" className="ghost" disabled={disabled} onClick={onExit}>Exit plan mode</button>}</div>
    {planning && <p className="work-plan-hint">Explore and refine the plan. Implementation starts when you choose Implement plan.</p>}
    {plan && <>
      <p className="work-plan-objective">{plan.objective}</p>
      {steps.length > 0 ? (
        <>
          <p className="work-plan-current" role="status">{active ? `In progress: ${active.text}` : next ? `Next: ${next.text}` : 'All steps complete'}</p>
          <details className="work-plan-steps">
            <summary><span>{completed} of {steps.length} complete</span></summary>
            <ol>{steps.map(step => <li key={step.id} className={`work-plan-step is-${step.status}`}>
              <label><input type="checkbox" checked={step.status === 'completed'} disabled={disabled || planning} onChange={event => onToggle(step.id, event.target.checked, plan.revision)} /><span>{step.text}{step.status === 'in_progress' && <small>In progress</small>}</span></label>
            </li>)}</ol>
          </details>
        </>
      ) : (
        <p className="work-plan-current" role="status">All steps complete</p>
      )}
      {proposal && <><div className="work-plan-proposal"><Markdown content={proposal} /></div><div className="work-plan-actions"><button type="button" className="primary" disabled={disabled} onClick={() => onImplement(plan.revision)}>Implement plan</button></div></>}
    </>}
    {planning && !proposal && <p className="work-plan-hint">{plan ? 'The proposal is being refined. Send a message to add details or request changes.' : 'Send a task to start planning.'}</p>}
  </section>;
}
