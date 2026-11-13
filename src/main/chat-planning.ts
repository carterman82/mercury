import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatThread } from '../shared/types';
import { ToolFailure } from './tool-outcome';

type WorkPlan = NonNullable<ChatThread['workPlan']>;
type PlanStep = WorkPlan['steps'][number];
const textSchema = z.string().trim().min(1).max(500);
const submitSchema = z.object({ proposal: z.string().trim().min(1).max(16000), steps: z.array(textSchema).min(1).max(20) }).strict();
const updateSchema = z.object({
  explanation: z.string().trim().max(2000).optional(),
  plan: z.array(z.object({ step: textSchema, status: z.enum(['pending', 'in_progress', 'completed']) }).strict()).min(1).max(20),
}).strict().refine(value => value.plan.filter(step => step.status === 'in_progress').length <= 1, 'At most one step may be in progress.');

export function parsePlanCommand(text: string): { command: 'enter' | 'exit' | null; prompt: string } {
  const match = /^\s*\/plan(?:\s+([\s\S]*))?\s*$/i.exec(text);
  if (!match) return { command: null, prompt: text };
  const prompt = (match[1] ?? '').trim();
  return { command: /^off$/i.test(prompt) ? 'exit' : 'enter', prompt: /^off$/i.test(prompt) ? '' : prompt };
}

export const planningInstructions = `PLAN MODE
Explore the actual project before asking questions. Clarify consequential intent and implementation tradeoffs, then prepare a decision-complete proposal with a summary, concrete steps, tests and assumptions. Ask only questions whose answers cannot be discovered from the project.
Do not implement, edit source, install software, invoke plugins, integrate changes or assign implementation/testing workers. Read files, research and use confined diagnostics to improve the proposal. Diagnostics run with read-only project access and disabled network; never request broader access. Investigation/review workers may only read and report findings.
When ready, call submit_plan with the finished proposal and short ordered implementation steps, and present the proposal in a <proposed_plan> block. Do not call update_plan or mark acceptance requirements complete. Stay in Plan mode until the user explicitly switches modes or chooses Implement plan in Mercury. A request saying implement does not itself change the application mode. Planning does not authorize execution.`;

export const executionPlanInstructions = `EXECUTION CHECKLIST
For nontrivial work involving multiple steps, a feature, migration or refactor, call update_plan before implementation and keep the checklist current as you work. Use pending, in_progress and completed, with at most one step in progress. Check off finished steps promptly and explain material changes. Simple edits and informational answers need no checklist. The checklist tracks work, not proof: keep acceptance requirements and verification evidence accurate separately. Automatic checklists do not require a new approval pause; continue authorized implementation. Never mark unfinished steps completed merely to finish a response.`;

function tool(name: string, description: string, schema: z.ZodType) {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema);
  return { type: 'function' as const, function: { name, description, parameters } };
}
export const submitPlanTool = tool('submit_plan', 'Save a reviewable implementation proposal and ordered steps while in Plan mode. This does not approve or execute it.', submitSchema);
export const updatePlanTool = tool('update_plan', 'Update the execution checklist with the full ordered list of steps and statuses. At most one step may be in progress. Does not change collaboration mode or verification evidence.', updateSchema);

function stepsWithIds(previous: WorkPlan | undefined, items: { text: string; status: PlanStep['status'] }[]): PlanStep[] {
  const unused = [...(previous?.steps ?? [])];
  return items.map(item => {
    const index = unused.findIndex(step => step.text === item.text);
    const id = index < 0 ? randomUUID() : unused.splice(index, 1)[0].id;
    return { id, ...item };
  });
}
function objective(chat: ChatThread, proposal = ''): string {
  const request = [...chat.messages].reverse().find(message => message.role === 'user')?.content;
  return (chat.workPlan?.objective ?? ((request ? parsePlanCommand(request).prompt : '') || proposal.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '') || chat.title)).slice(0, 4000);
}

export function submitChatPlan(chat: ChatThread, raw: unknown): WorkPlan {
  if (chat.collaborationMode !== 'plan') throw new ToolFailure('PLAN_MODE_REQUIRED', 'Switch to Plan mode before submitting a proposal.');
  const value = submitSchema.parse(raw);
  chat.workPlan = {
    revision: (chat.workPlan?.revision ?? 0) + 1, origin: 'explicit', objective: objective(chat, value.proposal), proposal: value.proposal,
    steps: stepsWithIds(chat.workPlan, value.steps.map(text => ({ text, status: 'pending' }))), updatedAt: Date.now(),
  };
  return chat.workPlan;
}

export function updateChatPlan(chat: ChatThread, raw: unknown): WorkPlan {
  if (chat.collaborationMode === 'plan') throw new ToolFailure('PLAN_MODE_READ_ONLY', 'update_plan tracks execution. Submit a proposal with submit_plan while in Plan mode.');
  const value = updateSchema.parse(raw);
  chat.workPlan = {
    revision: (chat.workPlan?.revision ?? 0) + 1, origin: chat.workPlan?.origin ?? 'automatic', objective: objective(chat),
    ...(chat.workPlan?.proposal ? { proposal: chat.workPlan.proposal } : {}),
    steps: stepsWithIds(chat.workPlan, value.plan.map(item => ({ text: item.step, status: item.status }))), updatedAt: Date.now(),
  };
  return chat.workPlan;
}

export function isSubstantialTask(text: string): boolean {
  const request = text.trim();
  if (/^(?:what|why|how|explain|describe|show|list|tell me|is|are|does)\b/i.test(request)) return false;
  if (/\b(?:typo|spelling|punctuation|rename (?:a |the )?(?:variable|label)|change (?:a |the )?(?:label|heading|color))\b/i.test(request) && !/\b(?:migrat\w*|refactor\w*|architect\w*)\b/i.test(request)) return false;
  if (/\b(?:migrat\w*|refactor\w*|architect\w*|redesign\w*|overhaul\w*)\b/i.test(request)) return true;
  const implementation = /\b(?:implement|build|create|add|integrate|fix|replace|develop|support|upgrade)\b/i.test(request);
  return implementation && (/\b(?:feature|dashboard|authentication|workflow|integration|end.to.end|across|multiple|system|module|API|sandbox)\b/i.test(request) || /\b(?:and|with|then)\b|(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/m.test(request));
}

const defaultSteps = ['Inspect the project and confirm the approach', 'Implement the requested changes', 'Verify the behavior and report results'];
export function seedAutomaticPlan(chat: ChatThread, request: string, force = false): WorkPlan | undefined {
  if (chat.collaborationMode === 'plan' || (!force && !isSubstantialTask(request)) || chat.workPlan?.steps.some(step => step.status !== 'completed')) return chat.workPlan;
  chat.workPlan = {
    revision: (chat.workPlan?.revision ?? 0) + 1, origin: 'automatic', objective: request.slice(0, 4000),
    steps: defaultSteps.map((text, index) => ({ id: randomUUID(), text, status: index === 0 ? 'in_progress' : 'pending' })), updatedAt: Date.now(),
  };
  return chat.workPlan;
}

export function advanceAutomaticPlan(chat: ChatThread, event: 'mutation' | 'test' | 'completed'): void {
  const plan = chat.workPlan;
  if (chat.collaborationMode === 'plan' || plan?.origin !== 'automatic' || plan.steps.length !== defaultSteps.length ||
      plan.steps.some((step, index) => step.text !== defaultSteps[index])) return;
  // A diagnostic before implementation is exploration, not verification of a change.
  if (event === 'test' && (plan.steps[1].status === 'pending' || plan.steps[2].status === 'completed')) return;
  const statuses: PlanStep['status'][] = event === 'mutation'
    ? ['completed', 'in_progress', 'pending']
    : event === 'test' ? ['completed', 'completed', 'in_progress'] : ['completed', 'completed', 'completed'];
  if (plan.steps.every((step, index) => step.status === statuses[index])) return;
  chat.workPlan = { ...plan, revision: plan.revision + 1, updatedAt: Date.now(), steps: plan.steps.map((step, index) => ({ ...step, status: statuses[index] })) };
}

export function finalizePlanResponse(chat: ChatThread, text: string): string {
  if (chat.collaborationMode !== 'plan') return text;
  const proposed = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i.exec(text)?.[1]?.trim();
  if (!proposed || chat.workPlan?.proposal === proposed) return text;
  const lines = proposed.split('\n');
  const checklist = lines.flatMap(line => /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/.exec(line)?.[1]?.trim() ?? []);
  const bullets = lines.flatMap(line => /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)?.[1]?.trim() ?? []);
  const extracted = [...new Set(checklist.length ? checklist : bullets)].slice(0, 20).map(step => step.slice(0, 500));
  submitChatPlan(chat, { proposal: proposed.slice(0, 16000), steps: extracted.length ? extracted : defaultSteps });
  return text;
}

const readTools = new Set([
  'list_project_skills', 'read_project_skill', 'list_project_files', 'read_project_file', 'read_project_record', 'list_project_records',
  'search_project_files', 'read_project_notes', 'inspect_project_target', 'query_project_maps', 'read_project_task', 'read_file',
  'list_project_batches', 'read_project_batch', 'web_search', 'web_fetch', 'browser_search', 'browser_read',
  'browser_open', 'browser_click', 'browser_close', 'browser_wait', 'browser_screenshot', 'discover_plugins',
  'recall_context', 'read_chat_history', 'search_chat_history', 'submit_plan', 'delegate_task',
  'wait_project_tasks', 'review_project_task', 'accept_project_task', 'review_project_changes', 'project_server_status',
]);

/** Commands are safe here only because the host forces read-only confinement,
 * disabled networking, and no native fallback before executing them. */
export function planningToolAllowed(name: string, raw: unknown): boolean {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (name === 'start_project_task') return args.kind === 'investigation' || args.kind === 'review';
  if (name === 'run_project_command' || name === 'run_project_process')
    return args.filesystemAccess !== 'workspace-write' && args.network !== 'allow' && args.sandboxPermissions !== 'require_escalated' &&
      (args.writePaths === undefined || (Array.isArray(args.writePaths) && args.writePaths.length === 0));
  if (name === 'discover_project_python') return args.includeLauncher !== true;
  return readTools.has(name);
}
export function assertPlanningToolAllowed(chat: ChatThread, name: string, args: unknown): void {
  if (chat.collaborationMode === 'plan' && !planningToolAllowed(name, args))
    throw new ToolFailure('PLAN_MODE_READ_ONLY', 'Plan mode permits exploration and confined diagnostics only. Submit the proposal, then use Implement plan or switch modes before making changes. No action was executed.');
}

export function planContext(chat: ChatThread): string {
  if (!chat.workPlan) return JSON.stringify({ collaborationMode: chat.collaborationMode ?? 'default' });
  const plan = chat.workPlan;
  let limit = 4000;
  for (;;) {
    const summary = JSON.stringify({ collaborationMode: chat.collaborationMode ?? 'default', workPlan: {
      revision: plan.revision, origin: plan.origin, objective: plan.objective.slice(0, Math.min(1000, limit)),
      proposal: plan.proposal?.slice(0, limit), updatedAt: plan.updatedAt,
      steps: plan.steps.slice(0, 20).map(step => ({ id: step.id.slice(0, 100), text: step.text.slice(0, Math.min(180, limit)), status: step.status })),
    } });
    if (summary.length <= 20000) return summary;
    limit = Math.floor(limit / 2);
  }
}
