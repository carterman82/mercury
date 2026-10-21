import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assessProjectAction, OneShotProjectGrants, type ProjectAction, type ProjectPolicyContext } from './project-policy';

const root = path.resolve('policy-fixture');
const context: ProjectPolicyContext = { mode: 2, revision: 1, projectId: 'project', chatId: 'chat', workspaceRoot: root };
const inside = path.join(root, 'src', 'index.ts');
const outside = path.resolve('policy-fixture-other', 'file.txt');
const read: ProjectAction = { kind: 'read', paths: [inside] };
const command: ProjectAction = { kind: 'command', command: 'npm test', cwd: root };

describe('project action policy', () => {
  it.each([1, 2, 3] as const)('allows ordinary workspace reads and edits in mode %i', mode => {
    for (const kind of ['read', 'write'] as const) expect(assessProjectAction({ ...context, mode }, { kind, paths: [inside] }).status).toBe('allow');
  });
  it('distinguishes outside read and write authority and sibling prefixes', () => {
    expect(assessProjectAction({ ...context, mode: 1 }, { kind: 'read', paths: [outside] }).status).toBe('approval');
    expect(assessProjectAction(context, { kind: 'read', paths: [outside] }).status).toBe('allow');
    expect(assessProjectAction(context, { kind: 'write', paths: [inside, outside] }).status).toBe('approval');
    expect(assessProjectAction({ ...context, mode: 3 }, { kind: 'write', paths: [outside] }).status).toBe('allow');
  });
  it('denies restricted process execution even if its command looks safe', () => {
    for (const mode of [1, 2] as const) {
      expect(assessProjectAction({ ...context, mode }, command, { boundedLowRisk: true }).status).toBe('deny');
      expect(assessProjectAction({ ...context, mode }, { kind: 'plugin' }).status).toBe('deny');
    }
    expect(assessProjectAction({ ...context, mode: 3 }, command).status).toBe('allow');
    expect(assessProjectAction({ ...context, mode: 3 }, { kind: 'plugin' }).status).toBe('allow');
  });
  it('requires host confinement and bounded-effect proof for automatic commands', () => {
    expect(assessProjectAction(context, command, { isolationAvailable: true }).status).toBe('approval');
    expect(assessProjectAction(context, command, { isolationAvailable: true, boundedLowRisk: true }).status).toBe('allow');
    expect(assessProjectAction({ ...context, mode: 1 }, command, { isolationAvailable: true, boundedLowRisk: true }).status).toBe('approval');
    expect(assessProjectAction(context, { ...command, cwd: outside }, { isolationAvailable: true, boundedLowRisk: true }).status).toBe('approval');
    expect(assessProjectAction(context, { ...command, paths: [outside] }, { isolationAvailable: true, boundedLowRisk: true }).status).toBe('approval');
    expect(assessProjectAction(context, { ...command, destructive: true }, { isolationAvailable: true, boundedLowRisk: true }).status).toBe('approval');
    expect(assessProjectAction(context, { kind: 'plugin' }, { isolationAvailable: true }).status).toBe('approval');
  });
  it('requires integration and destructive-operation review in restricted modes', () => {
    for (const mode of [1, 2] as const) {
      expect(assessProjectAction({ ...context, mode }, { kind: 'integrate', contentHash: 'combined-diff' }).status).toBe('approval');
      expect(assessProjectAction({ ...context, mode }, { kind: 'write', paths: [inside], destructive: true }).status).toBe('approval');
    }
    expect(assessProjectAction({ ...context, mode: 3 }, { kind: 'integrate' }).status).toBe('allow');
  });
  it('fails closed for invalid context, relative paths, missing targets and unknown actions', () => {
    expect(assessProjectAction({ ...context, mode: 9 as 1 }, read).status).toBe('deny');
    expect(assessProjectAction({ ...context, revision: NaN }, read).status).toBe('deny');
    expect(assessProjectAction({ ...context, workspaceRoot: 'relative' }, read).status).toBe('deny');
    expect(assessProjectAction(context, { kind: 'read', paths: ['relative'] }).status).toBe('deny');
    expect(assessProjectAction(context, { kind: 'write' }).status).toBe('deny');
    expect(assessProjectAction(context, { kind: 'command', command: '' }).status).toBe('deny');
    expect(assessProjectAction(context, { kind: 'unsupported' as 'read' }).status).toBe('deny');
  });
});

describe('one-shot project approvals', () => {
  it('binds approval to the exact chat, agent, revision, content, command and workspace', () => {
    const changes: Array<[ProjectPolicyContext, ProjectAction]> = [
      [{ ...context, projectId: 'other' }, command], [{ ...context, chatId: 'other' }, command],
      [{ ...context, revision: 2 }, command], [{ ...context, mode: 3 }, command],
      [{ ...context, workspaceRoot: outside }, command], [context, { ...command, command: 'npm test && erase-files' }],
      [context, { ...command, cwd: outside }], [context, { ...command, contentHash: 'changed' }],
      [context, { ...command, agentId: 'subagent' }], [context, { ...command, destructive: true }],
    ];
    const grants = new OneShotProjectGrants();
    for (const [changedContext, changedAction] of changes) {
      const id = grants.issue(context, command);
      expect(grants.consume(id, changedContext, changedAction)).toBe(false);
      expect(grants.consume(id, context, command)).toBe(false);
    }
    const id = grants.issue(context, command);
    expect(grants.consume(id, context, command)).toBe(true);
    expect(grants.consume(id, context, command)).toBe(false);
    expect(grants.consume('invented', context, command)).toBe(false);
  });
  it('invalidates grants on expiration, cancellation, policy changes and restart', () => {
    let time = 0;
    const grants = new OneShotProjectGrants(() => time, 100);
    const expired = grants.issue(context, read); time = 100;
    expect(grants.consume(expired, context, read)).toBe(false);
    const cancelled = grants.issue(context, read);
    expect(grants.consume(cancelled, context, read, AbortSignal.abort())).toBe(false);
    const first = grants.issue(context, read);
    const otherContext = { ...context, projectId: 'other' };
    const other = grants.issue(otherContext, read);
    grants.invalidateProject(context.projectId);
    expect(grants.consume(first, context, read)).toBe(false);
    expect(grants.consume(other, otherContext, read)).toBe(true);
    const restarted = grants.issue(context, read);
    expect(new OneShotProjectGrants().consume(restarted, context, read)).toBe(false);
    grants.clear(); expect(grants.consume(restarted, context, read)).toBe(false);
    expect(() => new OneShotProjectGrants(Date.now, 0)).toThrow('positive');
  });
});
