import React from 'react';
import { Markdown } from './Markdown';
import type { ProjectAssignment } from '../shared/types';

type Status = ProjectAssignment['status'] | 'succeeded';
const statusLabels: Record<Status, string> = {
  queued: 'Queued', running: 'Working', completed: 'Done', accepted: 'Done', succeeded: 'Done', failed: 'Failed', interrupted: 'Interrupted',
};

/** Shared presentation for ordinary delegates and SDK-backed project workers. */
export function SubagentActivity({ label, status, result, task, error, children }: {
  label: string; status: Status; result?: string; task?: string; error?: string; children?: React.ReactNode;
}) {
  return <div className="subagent-entry">
    <span role="status">{statusLabels[status]} · {label}</span>
    {task && <p className="subagent-task">{task}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <details><summary>{status === 'failed' && !error ? 'Task error' : 'Subagent findings'}</summary><Markdown content={result} /></details>}
    {children}
  </div>;
}
