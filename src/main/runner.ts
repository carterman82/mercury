import { delegateTask, delegationTool, resolveModel } from './delegation';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parsePlan, planMarkdown, planSchema } from '../shared/plan';
import type { AgentRole, ModelProfile, PlanContent, Session, Settings, ToolRequest } from '../shared/types';
import { CommandGate, runCommand } from './commands';
import { LocalProviders } from './providers';
import { Store } from './store';
import { Workspace } from './workspace';
import { discoverPlugins } from './plugins';

const readTools = [
  { type: 'function', function: { name: 'list_files', description: 'List project files', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: 'Read numbered lines of a project file and obtain its content hash', parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_text', description: 'Search project text for a literal phrase', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'discover_plugins', description: 'Find built-in and project-local plugins relevant to a task. This only reports plugins; it never installs or executes one.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];
const codeTools = [
  ...readTools, delegationTool,
  { type: 'function', function: { name: 'edit_file', description: 'Replace a whole file. Read its hash first; use null only to create a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, expectedHash: { anyOf: [{ type: 'string' }, { type: 'null' }] }, content: { type: 'string' } }, required: ['path', 'expectedHash', 'content'] } } },
  { type: 'function', function: { name: 'create_pdf', description: 'Create a new simple text PDF in the project. It refuses to overwrite an existing PDF.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Request user approval to run one project command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'finish', description: 'Finish implementation with a summary of changes and verification results', parameters: { type: 'object', properties: { summary: { type: 'string' }, verification: { type: 'string' } }, required: ['summary', 'verification'] } } },
];
const readSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('list_files'), arguments: z.object({}) }),
  z.object({ name: z.literal('read_file'), arguments: z.object({ path: z.string(), start: z.number().int().optional(), end: z.number().int().optional() }) }),
  z.object({ name: z.literal('search_text'), arguments: z.object({ query: z.string() }) }),
  z.object({ name: z.literal('discover_plugins'), arguments: z.object({ query: z.string().min(1).max(500) }) }),
]);
const codeSchema = z.discriminatedUnion('name', [
  ...readSchema.options,
  z.object({ name: z.literal('edit_file'), arguments: z.object({ path: z.string(), expectedHash: z.string().nullable(), content: z.string() }) }),
  z.object({ name: z.literal('create_pdf'), arguments: z.object({ path: z.string(), content: z.string().max(512_000) }) }),
  z.object({ name: z.literal('run_command'), arguments: z.object({ command: z.string().min(1).max(2_000) }) }),
  z.object({ name: z.literal('finish'), arguments: z.object({ summary: z.string(), verification: z.string() }) }),
]);

export class Runner {
  private active: { sessionId: string; controller: AbortController; gate: CommandGate } | null = null;
  activeRole: AgentRole | null = null;
  get running(): boolean { return this.active !== null; }
  constructor(private store: Store, private providers: LocalProviders, private onChange: () => void) {}
  private save(session: Session): void { this.store.saveSession(session); this.onChange(); }
  private event(session: Session, kind: Session['events'][number]['kind'], text: string, role?: AgentRole): void {
    session.events.push({ id: randomUUID(), at: Date.now(), kind, text: text.slice(0, 50_000), role });
    this.save(session);
  }
  private getWorkspace(session: Session): Workspace {
    const project = this.store.projects().find(project => project.id === session.projectId);
    if (!project) throw new Error('Project not found.');
    return new Workspace(project.path);
  }
  private assignments(settings: Settings): Record<AgentRole, ModelProfile> {
    return { planner: resolveModel(settings, 'planner'), main: resolveModel(settings, 'main'), subagent: resolveModel(settings, 'subagent') };
  }

  private begin(session: Session): { controller: AbortController; gate: CommandGate } {
    if (this.active) throw new Error('Another run is active.');
    const controller = new AbortController();
    const gate = new CommandGate(request => { session.command = request; if (request) session.status = 'awaiting_command'; else if (session.status === 'awaiting_command') session.status = 'implementing'; this.save(session); });
    this.active = { sessionId: session.id, controller, gate };
    return { controller, gate };
  }
  private end(): void { this.activeRole = null; this.active = null; this.onChange(); }
  async stop(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) throw new Error('This session is not running.');
    this.active.controller.abort(new Error('Stopped by user.'));
    this.active.gate.cancel();
  }
  answerCommand(sessionId: string, id: string, allow: boolean, remember: boolean): void {
    if (this.active?.sessionId !== sessionId) throw new Error('This session is not running.');
    this.active.gate.answer(id, allow, remember);
  }
  private async projectContext(workspace: Workspace): Promise<string> {
    const files = await workspace.list('', 150);
    const preferred = files.filter(file => /(^|\/)(README[^/]*|AGENTS\.md|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(file)).slice(0, 6);
    const excerpts: string[] = [];
    for (const file of preferred) {
      try { excerpts.push(`### ${file}\n${(await workspace.read(file, 1, 80)).content}`); } catch { /* Skip unreadable project metadata. */ }
    }
    return `Files (first 150):\n${files.join('\n')}\n\n${excerpts.join('\n\n')}`.slice(0, 22_000);
  }
  private async useTool(workspace: Workspace, call: ToolRequest, role: AgentRole, session: Session, signal: AbortSignal, gate: CommandGate): Promise<string> {
    if (role === 'main' && call.name === 'delegate_task') {
      this.event(session, 'tool', 'Subagent is analyzing the delegated task.', 'subagent');
      try {
        const findings = await delegateTask(this.providers, session.assignments!.subagent, call.arguments, signal, readTools.filter((tool: any) => tool.function.name !== 'discover_plugins'), async read => this.useTool(workspace, read, 'subagent', session, signal, gate));
        this.event(session, 'message', findings, 'subagent');
        return findings;
      } catch (error) {
        if (signal.aborted) throw error;
        const message = 'Subagent failed: ' + String(error);
        this.event(session, 'error', message, 'subagent');
        return message;
      }
    }
    const parsed = role === 'main' ? codeSchema.parse(call) : readSchema.parse(call);
    const args: any = parsed.arguments;
    if (parsed.name === 'list_files') return JSON.stringify(await workspace.list());
    if (parsed.name === 'read_file') return JSON.stringify(await workspace.read(args.path, args.start, args.end));
    if (parsed.name === 'search_text') return JSON.stringify(await workspace.search(args.query));
    if (parsed.name === 'discover_plugins') return JSON.stringify(await discoverPlugins(workspace.root, args.query));
    if (parsed.name === 'edit_file') {
      this.event(session, 'tool', `Editing ${args.path}`, role);
      const change = await workspace.edit(args.path, args.expectedHash, args.content);
      session.changes.push(change);
      this.event(session, 'change', `Changed ${change.path}`, role);
      return JSON.stringify({ changed: change.path });
    }
    if (parsed.name === 'create_pdf') {
      this.event(session, 'tool', `Creating PDF ${args.path}`, role);
      const change = await workspace.createPdf(args.path, args.content);
      session.changes.push(change);
      this.event(session, 'change', `Created ${change.path}`, role);
      return JSON.stringify({ created: change.path });
    }
    if (parsed.name === 'run_command') {
      this.event(session, 'tool', `Requested command: ${args.command}`, role);
      const approved = await gate.ask(args.command, workspace.root, signal);
      if (!approved) return 'User denied the command. Do not retry it automatically.';
      this.event(session, 'command', `Running: ${args.command}`, role);
      const outcome = await runCommand(args.command, workspace.root, signal);
      this.event(session, 'command', `Exit ${outcome.exitCode}: ${outcome.output}`, role);
      return JSON.stringify(outcome);
    }
    if (parsed.name === 'finish') {
      this.event(session, 'message', `${args.summary}\n\nVerification: ${args.verification}`, role);
      session.status = 'completed';
      this.save(session);
      return 'Finished.';
    }
    throw new Error('Unknown tool.');
  }
  private async agent(session: Session, workspace: Workspace, role: AgentRole, prompt: string, signal: AbortSignal, gate: CommandGate, maxTurns: number): Promise<string> {
    this.activeRole = role;
    this.onChange();
    const profile = session.assignments![role];
    const messages: any[] = [{ role: 'system', content: `You are the ${role} agent in a local coding assistant. Follow the user's objective and project evidence. Only use offered tools. Main may use delegate_task for bounded read-only analysis and must act on the returned findings itself. When a task may need a specialized capability, call discover_plugins before proceeding; it is safe and informational. Never claim unrun checks passed. Keep responses concise.` }, { role: 'user', content: prompt }];
    let finalText = '';
    let repairedToolError = false;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal.aborted) throw signal.reason;
      const current = session.events.length;
      this.event(session, 'message', '', role);
      const result = await this.providers.chat({ profile, messages, tools: role === 'main' ? codeTools : readTools, signal, onText: delta => {
        const item = session.events[current];
        if (item) { item.text = (item.text + delta).slice(0, 50_000); this.save(session); }
      } });
      finalText = result.text;
      if (result.tools.length === 0) return result.text;
      const assistant: any = { role: 'assistant', content: result.text || null, tool_calls: result.tools.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
      messages.push(assistant);
      for (const call of result.tools) {
        if (signal.aborted) throw signal.reason;
        let toolResult: string;
        try { toolResult = await this.useTool(workspace, call, role, session, signal, gate); }
        catch (error) {
          if (signal.aborted || call.name === 'edit_file' || call.name === 'run_command' || repairedToolError) throw error;
          repairedToolError = true;
          toolResult = `Tool error: ${String(error)}. Correct the arguments once or stop.`;
          this.event(session, 'error', toolResult, role);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult.slice(0, 20_000) });
        if (session.status === 'completed') return finalText;
      }
      const maxCharacters = Math.min(profile.contextLimit * 3, 80_000);
      while (JSON.stringify(messages).length > maxCharacters && messages.length > 4) messages.splice(2, 2);
      if (JSON.stringify(messages).length > maxCharacters) throw new Error('Context limit reached. Select a model with a larger context or narrow the task.');
    }
    throw new Error(`${role} reached the ${maxTurns}-turn limit. The run was paused.`);
  }
  async plan(sessionId: string, feedback = ''): Promise<void> {
    const session = this.store.session(sessionId);
    if (!['draft', 'awaiting_review', 'awaiting_input', 'interrupted', 'failed'].includes(session.status)) throw new Error('This session cannot start planning now.');
    const assignments = this.assignments(this.store.settings());
    const { controller, gate } = this.begin(session);
    session.assignments = assignments;
    session.status = 'planning';
    this.save(session);
    try {
      const workspace = this.getWorkspace(session);
      const context = await this.projectContext(workspace);
      const prior = session.plan ? `Previous plan:\n${planMarkdown(session.plan.content)}\nFeedback: ${feedback}` : '';
      let proposal = await this.agent(session, workspace, 'planner', `Objective: ${session.objective}\n${prior}\nProject:\n${context}\nInspect relevant files with read-only tools. Plan project infrastructure and the requested changes, identify assumptions and verification. Return ONLY a JSON object with objective:string, assumptions:string[], steps:[{title:string,details:string,checks:string[]}], blockers:string[]. Blockers are questions requiring user answers before implementation.`, controller.signal, gate, 8);
      let content: PlanContent;
      try { content = parsePlan(proposal); }
      catch {
        proposal = await this.agent(session, workspace, 'planner', `Repair this invalid plan. Return ONLY JSON with objective, assumptions, steps, blockers:\n${proposal}`, controller.signal, gate, 1);
        content = parsePlan(proposal);
      }
      session.plan = { revision: (session.plan?.revision ?? 0) + 1, content, approved: false, createdAt: Date.now() };
      session.status = content.blockers.length ? 'awaiting_input' : 'awaiting_review';
      this.save(session);
    } catch (error) {
      session.status = controller.signal.aborted ? 'cancelled' : 'failed';
      this.event(session, 'error', String(error));
    } finally { this.end(); }
  }
  savePlan(sessionId: string, content: PlanContent): void {
    const session = this.store.session(sessionId);
    if (!['awaiting_review', 'awaiting_input', 'interrupted', 'failed'].includes(session.status)) throw new Error('Plan cannot be edited during a run.');
    const valid = planSchema.parse(content);
    session.plan = { revision: (session.plan?.revision ?? 0) + 1, content: valid, approved: false, createdAt: Date.now() };
    session.status = valid.blockers.length ? 'awaiting_input' : 'awaiting_review';
    this.save(session);
  }
  async approve(sessionId: string, revision: number): Promise<void> {
    const session = this.store.session(sessionId);
    if (session.status !== 'awaiting_review' || !session.plan || session.plan.revision !== revision) throw new Error('The plan changed or still has blocking questions. Review the current revision.');
    if (session.plan.content.blockers.length) throw new Error('Resolve blocking questions first.');
    const coder = session.assignments?.main;
    if (!coder) throw new Error('The Main model is not configured.');
    const { controller, gate } = this.begin(session);
    session.status = 'implementing';
    this.activeRole = 'main';
    this.save(session);
    try {
      if (!coder.toolVerified) {
        const capable = await this.providers.probe(coder, controller.signal);
        if (!capable) throw new Error('The selected Main model did not pass the tool-use check. Select a model with working tool calls.');
        coder.toolVerified = true;
      }
    } catch (error) {
      session.status = controller.signal.aborted ? 'cancelled' : 'awaiting_review';
      this.event(session, 'error', String(error));
      this.end();
      return;
    }
    session.plan.approved = true;
    this.save(session);
    await this.implement(session, controller, gate);
  }
  private async implement(session: Session, controller: AbortController, gate: CommandGate): Promise<void> {
    try {
      const workspace = this.getWorkspace(session);
      await this.agent(session, workspace, 'main', `Implement this user-approved plan in ${workspace.root}:\n${planMarkdown(session.plan!.content)}\nRead files before editing. Use edit_file with exact hashes. Ask to run checks through run_command. Finish with a truthful summary and verification outcome.`, controller.signal, gate, 20);
      if (session.status !== 'completed') { session.status = 'interrupted'; this.event(session, 'status', 'The Main model stopped without marking the work complete. Review changes and resume.'); }
    } catch (error) {
      session.status = controller.signal.aborted ? 'cancelled' : 'interrupted';
      this.event(session, 'error', String(error));
    } finally { this.end(); }
  }
  async resume(sessionId: string): Promise<void> {
    const session = this.store.session(sessionId);
    if (session.status !== 'interrupted' || !session.plan?.approved) throw new Error('Only an interrupted approved implementation can be resumed.');
    const { controller, gate } = this.begin(session);
    session.status = 'implementing';
    this.save(session);
    await this.implement(session, controller, gate);
  }
}
