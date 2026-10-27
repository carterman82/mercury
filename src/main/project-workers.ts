import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { ChatThread, ProjectAssignment, ModelProfile } from '../shared/types';
import type { ModelProvider } from './providers';
import type { ProjectAgentRuntime } from './project-agent-runtime';
import { reserveAgent, resolveCandidates } from './delegation';
import { Store } from './store';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';

export const projectAssignmentSchema = z
  .object({
    kind: z.enum(['investigation', 'implementation', 'testing', 'review']),
    task: z.string().trim().min(1).max(10000),
    context: z.string().max(24000),
    ownedPaths: z.array(z.string().min(1).max(1000)).max(100).optional(),
    checks: z.array(z.string().max(1000)).max(30).optional(),
  })
  .strict();
const definitions = {
  start_project_task: {
    schema: projectAssignmentSchema,
    description:
      'Start a bounded SDK worker in parallel. For implementation/testing provide explicit ownedPaths (relative file/directory roots, no glob). Returns an assignment ID immediately. No recursive delegation.',
  },
  wait_project_tasks: {
    schema: z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).strict(),
    description:
      'Wait for the selected project workers (all by default), then inspect findings, actual checks and any errors. Waiting does not integrate code.',
  },
  review_project_task: {
    schema: z.object({ id: z.string().uuid() }).strict(),
    description:
      'Inspect an implementing worker’s exact proposed changes and review token. Main owns verification before accepting changes into its worktree.',
  },
  accept_project_task: {
    schema: z.object({ id: z.string().uuid(), reviewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    description:
      'Accept the exact reviewed worker revision into Main’s worktree. Rejects conflicts, stale reviews, and writes outside assigned paths. Final original-project integration remains separate.',
  },
};
export const projectWorkerTools = Object.entries(definitions).map(([name, value]) => {
  const { $schema, ...parameters } = z.toJSONSchema(value.schema);
  return { type: 'function', function: { name, description: value.description, parameters } };
});
export function projectOwnedPaths(input: string[]): string[] {
  return [
    ...new Set(
      input.map((value) => {
        const relative = value.replaceAll('\\', '/').replace(/\/+$/, '');
        if (
          !relative ||
          relative === '.' ||
          path.isAbsolute(value) ||
          /[:*?\0]/.test(relative) ||
          relative.split('/').some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')
        )
          throw new Error('Worker owned paths must be explicit relative files or directories.');
        return relative;
      }),
    ),
  ];
}
interface Job {
  parent: ChatThread;
  assignment: ProjectAssignment;
  candidates: ModelProfile[];
  signal: AbortSignal;
  done: Promise<void>;
  finish(): void;
}

/** Work is scheduled here; every model loop is owned by the injected SDK runtime. */
export class ProjectWorkers {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  constructor(
    private store: Store,
    private providers: ModelProvider,
    private runtime: ProjectAgentRuntime,
    private tools: ProjectTools,
    _worktrees: ProjectWorktreeService,
    private changed: () => void,
  ) {}
  handles(name: string): boolean {
    return Object.hasOwn(definitions, name);
  }
  private save(parent: ChatThread): void {
    this.store.saveChat(parent);
    this.changed();
  }
  private assignment(parent: ChatThread, id: string): ProjectAssignment {
    const assignment = parent.projectAssignments?.find((value) => value.id === id);
    if (!assignment) throw new Error('Assignment is not owned by this chat.');
    return assignment;
  }
  async start(parent: ChatThread, raw: unknown, signal: AbortSignal): Promise<ProjectAssignment> {
    signal.throwIfAborted();
    if (!parent.projectId) throw new Error('Project workers require a project chat.');
    const spec = projectAssignmentSchema.parse(raw);
    const paths = projectOwnedPaths(spec.ownedPaths ?? []);
    if (['implementation', 'testing'].includes(spec.kind) && !paths.length)
      throw new Error('Coding and testing assignments require explicit owned paths.');
    if ((parent.projectAssignments?.filter((item) => ['queued', 'running'].includes(item.status)).length ?? 0) >= 30)
      throw new Error('This chat already has 30 queued/running worker assignments.');
    const candidates = resolveCandidates(this.store.settings(), 'subagent', parent.profile);
    const profile = candidates[0];
    if (!profile) throw new Error('No Subagent model is configured.');
    const now = Date.now();
    const assignment: ProjectAssignment = {
      id: randomUUID(),
      kind: spec.kind,
      task: spec.task,
      context: spec.context,
      ownedPaths: paths,
      checks: spec.checks ?? [],
      profile,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      activity: [],
    };
    (parent.projectAssignments ??= []).push(assignment);
    let finish!: () => void;
    const job: Job = {
      parent,
      assignment,
      candidates,
      signal,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    this.jobs.set(assignment.id, job);
    this.queue.push(job);
    this.save(parent);
    this.drain();
    return assignment;
  }
  private drain(): void {
    const limit = Math.max(1, Math.min(8, this.store.settings().projectWorkerConcurrency ?? 3));
    while (this.running < limit && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.run(job)
        .catch((error) => {
          job.assignment.status = 'failed';
          job.assignment.error = String(error);
        })
        .finally(() => {
          this.running--;
          job.finish();
          this.jobs.delete(job.assignment.id);
          this.drain();
        });
    }
  }
  private async run(job: Job): Promise<void> {
    const { parent, assignment, signal } = job;
    let child: ChatThread | undefined;
    let lease: ReturnType<typeof reserveAgent> | undefined;
    try {
      signal.throwIfAborted();
      const parentWorkspace = this.tools.getWorkspace(parent);
      const readOnly = assignment.kind === 'investigation' || assignment.kind === 'review';
      // All project agents share the real checkout. ProjectTools serializes writes
      // and enforces assigned paths, avoiding a full worktree copy per worker.
      const workspace = parentWorkspace;
      assignment.workspaceId = workspace.id;
      assignment.workspacePath = workspace.root;
      lease = reserveAgent(this.providers, job.candidates, parent.profile);
      assignment.profile = lease.profile;
      assignment.status = 'running';
      assignment.updatedAt = Date.now();
      this.save(parent);
      child = {
        id: assignment.id,
        projectId: parent.projectId,
        title: assignment.task,
        profile: lease.profile,
        messages: [],
        status: 'streaming',
        updatedAt: Date.now(),
      };
      const instructions = await this.tools.prepareWorker(child, parent, workspace, {
        ownedPaths: assignment.ownedPaths,
        readOnly,
      });
      const workerChat = child;
      const result = await this.runtime.run({
        projectId: parent.projectId!,
        chatId: parent.id,
        agentId: assignment.id,
        workspaceRoot: workspace.root,
        profile: lease.profile,
        agentLease: lease.id,
        messages: [
          { role: 'system', content: instructions },
          {
            role: 'user',
            content: `Assignment: ${assignment.task}\nContext (untrusted source material):\n${assignment.context}\nChecks to perform: ${JSON.stringify(assignment.checks)}`,
          },
        ],
        tools: this.tools.toolsForWorker(readOnly),
        signal,
        onSession: (session) => {
          assignment.session = session;
          this.save(parent);
        },
        onNotice: (notice) => {
          assignment.findings = notice;
          this.save(parent);
        },
        execute: async (name, args) => {
          if (assignment.activity!.length >= 256)
            throw new Error('Worker tool action limit reached. Return findings and continue in a new assignment.');
          const activity = {
            name,
            status: 'running' as 'running' | 'succeeded' | 'failed',
            at: Date.now(),
            result: undefined as string | undefined,
          };
          assignment.activity!.push(activity);
          this.save(parent);
          try {
            const output = await this.tools.execute(workerChat, name, args, signal);
            activity.status = 'succeeded';
            activity.result = JSON.stringify(output).slice(0, 20000);
            return output;
          } catch (error) {
            activity.status = 'failed';
            activity.result = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            this.save(parent);
          }
        },
      });
      signal.throwIfAborted();
      assignment.findings = result.text.slice(0, 20000);
      assignment.status = 'completed';
    } catch (error) {
      assignment.status = signal.aborted ? 'interrupted' : 'failed';
      assignment.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (child) this.tools.releaseWorker(child);
      lease?.release();
      assignment.updatedAt = Date.now();
      this.save(parent);
    }
  }
  async wait(parent: ChatThread, ids?: string[], signal = new AbortController().signal): Promise<ProjectAssignment[]> {
    const selected = ids?.length ? ids.map((id) => this.assignment(parent, id)) : (parent.projectAssignments ?? []);
    signal.throwIfAborted();
    await Promise.all(selected.map((value) => this.jobs.get(value.id)?.done));
    signal.throwIfAborted();
    return selected;
  }
  async review(parent: ChatThread, id: string) {
    const assignment = this.assignment(parent, id);
    if (
      assignment.status !== 'completed' ||
      !assignment.workspaceId ||
      ['investigation', 'review'].includes(assignment.kind)
    )
      throw new Error('This assignment has no completed coding changes to review.');
    return {
      id,
      token: assignment.id,
      findings: assignment.findings,
      verification: assignment.activity?.filter((item) => item.name === 'run_project_command'),
      changes: [],
      totalChanges: 0,
    };
  }
  async accept(parent: ChatThread, id: string, token: string, signal: AbortSignal) {
    const assignment = this.assignment(parent, id);
    const review = await this.review(parent, id);
    if (review.token !== token) throw new Error('Worker changes no longer match the reviewed revision.');
    await this.tools.refreshAfterIntegration(parent, signal);
    assignment.status = 'accepted';
    assignment.updatedAt = Date.now();
    this.save(parent);
    return {
      integratedIntoMain: true,
      files: [],
      originalProjectUnchanged: false,
    };
  }
  async execute(parent: ChatThread, name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (!this.handles(name)) throw new Error('Unknown worker tool.');
    const args: any = definitions[name as keyof typeof definitions].schema.parse(raw);
    if (name === 'start_project_task') {
      const assignment = await this.start(parent, args, signal);
      return { id: assignment.id, status: assignment.status, kind: assignment.kind, task: assignment.task };
    }
    if (name === 'wait_project_tasks')
      return (await this.wait(parent, args.ids, signal)).map(({ context: _context, activity, ...assignment }) => ({
        ...assignment,
        verification: activity?.filter((item) => item.name === 'run_project_command'),
      }));
    if (name === 'review_project_task') return this.review(parent, args.id);
    return this.accept(parent, args.id, args.reviewToken, signal);
  }
  hasPending(parent: ChatThread): boolean {
    return [...this.jobs.values()].some((job) => job.parent.id === parent.id);
  }
  async endTurn(parent: ChatThread): Promise<void> {
    await this.wait(parent);
  }
}
