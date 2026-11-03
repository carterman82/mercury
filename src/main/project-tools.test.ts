import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Store } from './store';
import { ChatApprovals } from './chat-approvals';
import { ProjectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { ChatService } from './chat';
import { hash } from './workspace';
import type { ChatInput, ModelProvider } from './providers';
import type { ChatThread } from '../shared/types';
import { projectTestRuntime } from './project-test-runtime';
import { ProjectExecutionAdapter } from './project-execution';
import { ChatFiles } from './chat-files';
import { ProjectWorkers } from './project-workers';
import { ProjectMaps } from './project-maps';
import { ClaudeProjectRuntime, PROJECT_RUNTIME_BUILD } from './project-agent-runtime';
import { ChatBrowser } from './chat-browser';
import { WebPolicy } from './web-policy';
import { createServer } from 'node:http';
import { once } from 'node:events';

const cleanups: (() => Promise<void>)[] = [];
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 16000 };
function service(store: Store, provider: ModelProvider, projects: ProjectTools) {
  const runtime = projectTestRuntime(provider);
  const workers = new ProjectWorkers(store, provider, runtime, projects, new ProjectWorktreeService(path.join(path.dirname(store.projects()[0].path), 'worker-fixtures')), () => {});
  return new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime, workers);
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode: 1 | 2 | 3 = 2, repository = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-project-tools-'));
  const root = path.join(directory, 'source'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'note.txt'), 'old');
  if (repository) {
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', root, ...args], { windowsHide: true });
    await git('init'); await git('config', 'user.name', 'Project tests'); await git('config', 'user.email', 'test@example.invalid');
    await git('add', '.'); await git('commit', '-m', 'Fixture');
  }
  const store = new Store(path.join(directory, 'state.sqlite'));
  cleanups.push(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = { id: randomUUID(), path: root, name: 'Fixture', permissionMode: mode, policyRevision: 1 };
  store.saveProject(project);
  store.saveSettings({ connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }], mainModel: profile, plannerModel: null, subagentModel: null });
  const chat: ChatThread = { id: randomUUID(), projectId: project.id, title: 'Project', profile, messages: [], status: 'idle', updatedAt: Date.now() };
  store.saveChat(chat);
  const approvals = new ChatApprovals(() => {});
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'workspaces')));
  const controller = new AbortController();
  await projects.prepare(chat, controller.signal);
  return { directory, root, store, project, chat, approvals, projects, controller };
}

it('reads and edits the assigned project with hashes and preserves newer user content', async () => {
  const { projects, chat, root, controller } = await fixture();
  const read = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal) as { hash: string };
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: read.hash, content: 'new' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('new');
  await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: read.hash, content: 'stale' }, controller.signal)).rejects.toThrow(/changed/);
});

it('patches a large HTML file with an opaque revision and rejects stale or ambiguous edits', async () => {
  const { projects, chat, root, controller } = await fixture();
  const source = '<html>\n' + Array.from({ length: 527 }, (_, i) => `<p id="p${i}">你好 ${i}</p>`).join('\n') + '\n</html>';
  await fs.writeFile(path.join(root, 'index.html'), source);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'index.html' }, controller.signal);
  expect(read).toMatchObject({ totalLines: 529, startLine: 1, endLine: 200, truncated: true, nextStartLine: 201 });
  const second: any = await projects.execute(chat, 'read_project_file', { path: 'index.html', start: 201 }, controller.signal);
  expect(second.endLine).toBe(400);
  await expect(projects.execute(chat, 'edit_project_file', { path: 'index.html', revision: read.revision, content: 'const POSES = {};' }, controller.signal)).rejects.toThrow('half');
  await projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: read.revision, oldText: '你好 250', newText: 'Hello 世界' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'index.html'), 'utf8')).toBe(source.replace('你好 250', 'Hello 世界'));
  await expect(projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: read.revision, oldText: '你好 1', newText: 'changed' }, controller.signal)).rejects.toThrow('changed');
  const fresh: any = await projects.execute(chat, 'read_project_file', { path: 'index.html' }, controller.signal);
  await expect(projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: fresh.revision, oldText: '<p', newText: '<div' }, controller.signal)).rejects.toThrow('exactly one');
  controller.abort();
  await expect(projects.execute(chat, 'patch_project_file', { path: 'index.html', revision: fresh.revision, oldText: 'Hello 世界', newText: 'cancelled' }, controller.signal)).rejects.toThrow();
});

it('binds read revisions to the chat and file and allows intentional full rewrites', async () => {
  const { projects, chat, root, controller } = await fixture();
  await fs.writeFile(path.join(root, 'large.txt'), 'original '.repeat(200));
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'large.txt' }, controller.signal);
  await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', revision: read.revision, content: 'wrong file' }, controller.signal)).rejects.toThrow('this file/chat');
  await projects.execute(chat, 'edit_project_file', { path: 'large.txt', revision: read.revision, content: 'intentional', replacementIntent: true }, controller.signal);
  expect(await fs.readFile(path.join(root, 'large.txt'), 'utf8')).toBe('intentional');
});

it('patches logical multiline text in Windows files without changing surrounding line endings', async () => {
  const { projects, chat, root, controller } = await fixture();
  const source = 'before\r\nconst label = "你好";\r\nconst count = 1;\r\nafter\r\n';
  await fs.writeFile(path.join(root, 'windows.js'), source);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'windows.js' }, controller.signal);
  await projects.execute(chat, 'patch_project_file', { path: 'windows.js', revision: read.revision, oldText: 'const label = "你好";\nconst count = 1;', newText: 'const label = "世界";\nconst count = 2;' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'windows.js'), 'utf8')).toBe('before\r\nconst label = "世界";\r\nconst count = 2;\r\nafter\r\n');
});

it('stops a project reread loop after one recovery and preserves an actionable handoff', async () => {
  const { store, project, projects, directory } = await fixture();
  const completed = vi.fn(); let calls = 0;
  const provider = { chat: async () => { calls++; return { text: 'Let me read the source again.', tools: [{ id: `read-${calls}`, name: 'mcp__mercury__read_project_file', arguments: { path: 'note.txt' } }] }; } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(directory, 'loop-sessions'), { executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') });
  cleanups.push(() => runtime.shutdown());
  const service = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, runtime, undefined, completed);
  const id = await service.send(null, profile, 'Fix the project', [], undefined, project.id);
  const saved = store.chat(id);
  expect(calls).toBe(6); expect(saved.status).toBe('stopped'); expect(saved.error).toContain('after one recovery');
  expect(saved.messages.at(-1)?.metrics?.recoveries).toBe(1);
  expect(saved.projectHandoff?.reads).toHaveLength(1); expect(saved.projectHandoff?.objective).toBe('Fix the project');
  expect(completed).not.toHaveBeenCalled();
}, 60000);

it('accounts for real SDK schema rejections and stops varied invalid arguments before any edit',async()=>{
  const {store,project,projects,directory,root}=await fixture();let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    calls++;
    const definition=(input.tools as any[]).find(item=>item.function.name==='mcp__mercury__patch_project_file');
    expect(JSON.stringify(definition)).toContain('expectedHash');
    return {text:'',tools:[{id:`bad-${calls}`,name:'mcp__mercury__patch_project_file',arguments:{path:'note.txt',revision:`invalid-${calls}`,oldText:'old',newText:'must not write'}}]};
  }} as unknown as ModelProvider;
  const runtime=new ClaudeProjectRuntime(provider,path.join(directory,'invalid-sdk'),{executablePath:path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')});cleanups.push(()=>runtime.shutdown());
  const chats=new ChatService(store,provider,()=>{},()=>false,undefined,undefined,projects,runtime);
  const id=await chats.send(null,profile,'Inspect the file',[],undefined,project.id);const saved=store.chat(id),reply=saved.messages.at(-1)!;
  expect(calls).toBe(6);expect(saved.status).toBe('stopped');expect(reply.toolActivity).toHaveLength(6);expect(reply.toolActivity!.every(item=>item.status==='failed')).toBe(true);
  expect(reply.sourceEvidence!.every(item=>JSON.parse(item.result).code==='INVALID_ARGUMENTS')).toBe(true);expect(reply.metrics?.recoveries).toBe(1);expect(reply.runtimeBuild).toBe(PROJECT_RUNTIME_BUILD);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
},60000);

it('returns invalid SDK tool arguments to the model without blocking an otherwise complete project answer',async()=>{
  const {store,project,projects,directory,root}=await fixture();let calls=0;
  const provider={chat:async()=>{
    calls++;
    return calls===1
      ? {text:'',tools:[{id:'bad-read',name:'mcp__mercury__read_project_file',arguments:{path:''}}]}
      : {text:'The project rundown is complete despite the unavailable optional read.',tools:[]};
  }} as unknown as ModelProvider;
  const runtime=new ClaudeProjectRuntime(provider,path.join(directory,'validation-recovery-sdk'),{executablePath:path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')});cleanups.push(()=>runtime.shutdown());
  const id=await new ChatService(store,provider,()=>{},()=>false,undefined,undefined,projects,runtime).send(null,profile,'Give me a project rundown',[],undefined,project.id);
  const reply=store.chat(id).messages.at(-1)!;
  expect(calls).toBe(2);expect(store.chat(id).status).toBe('idle');
  expect(reply.delivery?.status).toBe('completed');expect(reply.toolActivity?.[0]).toMatchObject({name:'read_project_file',status:'failed'});
  expect(reply.sourceEvidence?.[0].result).toContain('INVALID_ARGUMENTS');
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
},60000);

it('clears a persisted validation-only blocker before a successful project follow-up',async()=>{
  const {store,project,projects,directory}=await fixture();
  const first={chat:async()=>({text:'',tools:[{id:'bad-read',name:'mcp__mercury__read_project_file',arguments:{path:''}}]})} as unknown as ModelProvider;
  const runtime=new ClaudeProjectRuntime(first,path.join(directory,'validation-follow-up-sdk'),{executablePath:path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')});cleanups.push(()=>runtime.shutdown());
  const chats=new ChatService(store,first,()=>{},()=>false,undefined,undefined,projects,runtime);
  const id=await chats.send(null,profile,'Inspect the project',[],undefined,project.id);
  const persisted=store.chat(id);
  persisted.projectHandoff!.blocker={tool:'read_project_file',target:'.',code:'INVALID_ARGUMENTS',message:'Invalid tool arguments.',nextAction:'Retry with a valid path.',at:Date.now()};
  store.saveChat(persisted);
  const second={chat:async()=>({text:'The project is healthy and the rundown is complete.',tools:[]})} as unknown as ModelProvider;
  const continued=new ChatService(store,second,()=>{},()=>false,undefined,undefined,projects,projectTestRuntime(second));
  await continued.send(id,profile,'Give me the complete rundown now.');
  const reply=store.chat(id).messages.at(-1)!;
  expect(store.chat(id).status).toBe('idle');expect(store.chat(id).projectHandoff?.blocker).toBeUndefined();expect(reply.delivery?.status).toBe('completed');
},60000);

it('refuses a missing contract before touching the workspace',async()=>{
  const {store,project,projects,root}=await fixture();let calls=0;
  const provider={chat:async()=>++calls===1?{text:'',tools:[{id:'edit',name:'edit_project_file',arguments:{path:'note.txt',expectedHash:hash('old'),content:'should not write'}}]}:{text:'The contract must be recorded first.',tools:[]}} as unknown as ModelProvider;
  const id=await service(store,provider,projects).send(null,profile,'Update the project',[],undefined,project.id);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
  const reply=store.chat(id).messages.at(-1)!;expect(JSON.parse(reply.sourceEvidence![0].result).code).toBe('NEED_TASK_CONTRACT');
});

it('rejects a server command before dispatch when no task contract exists',async()=>{
  const {store,project,projects}=await fixture(3);let calls=0;
  const execute=vi.spyOn(projects,'execute');
  const provider={chat:async()=>++calls===1?{text:'',tools:[{id:'server',name:'start_project_server',arguments:{command:'write arbitrary files',port:3000}}]}:{text:'Work remains blocked.',tools:[]}} as unknown as ModelProvider;
  const id=await service(store,provider,projects).send(null,profile,'Start implementing the website',[],undefined,project.id);
  expect(execute).not.toHaveBeenCalled();
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.[0].result).toContain('NEED_TASK_CONTRACT');
  expect(store.chat(id).messages.at(-1)?.delivery?.status).toBe('blocked');
});

it('treats omitted edit preconditions as create-only without overwriting existing content', async () => {
  const { projects, chat, controller, root } = await fixture(3);
  await projects.execute(chat, 'edit_project_file', { path: 'new.txt', content: 'created' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('created');
  for (const expectedHash of [undefined, 'null'])
    await expect(projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash, content: 'overwrite' }, controller.signal)).rejects.toMatchObject({ code: 'CREATE_TARGET_EXISTS', message: expect.stringContaining('No file was changed or reverted') });
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it('diagnoses typography and escaped-text patch mismatches without fuzzy editing the file', async () => {
  const { projects, chat, controller, root } = await fixture(3);
  for (const [source, oldText, reason] of [["It’s saved", "It's saved", 'TYPOGRAPHIC_QUOTES'], ["join('\\n')", "join('\\\\n')", 'OVER_ESCAPED_BACKSLASHES'], ['          <button>Load</button>', '           <button>Load</button>', 'LINE_INDENTATION']]) {
    await fs.writeFile(path.join(root, 'note.txt'), source);
    const read: any = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
    await expect(projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: read.revision, oldText, newText: 'changed' }, controller.signal)).rejects.toMatchObject({ code: 'PATCH_NO_MATCH', details: { reason, sourceLine: 1, sourceExcerpt: source } });
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe(source);
  }
});

it('delivers project browser images without an ordinary-chat file store', async () => {
  const { store, project, projects } = await fixture(3);
  const image = { mimeType: 'image/jpeg', data: 'screenshot-fixture' };
  const capabilities = { beginTurn: () => {}, endTurn: async () => {}, handles: (name: string) => name === 'browser_screenshot', execute: async () => ({ url: 'https://example.org/', _browserImage: image }) } as any;
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (++calls === 1) return { text: '', tools: [{ id: 'shot', name: 'browser_screenshot', arguments: {} }] };
    const result = JSON.parse((input.messages.at(-1) as any).content);
    expect(result.error).toBeUndefined();
    expect(result._mercuryImages).toEqual([image]);
    return { text: 'Captured the page; no behavior verified yet.', tools: [] };
  } } as unknown as ModelProvider;
  const chatService = new ChatService(store, provider, () => {}, () => false, undefined, capabilities, projects, projectTestRuntime(provider));
  const id = await chatService.send(null, profile, 'Inspect this page', [], undefined, project.id);
  expect(store.chat(id).messages.at(-1)?.toolActivity?.[0].status).toBe('succeeded');
  expect(store.chat(id).messages.at(-1)?.files).toBeUndefined();
});

it('returns a fresh scoped revision after a write for safe chained patches', async () => {
  const { projects, chat, controller, root } = await fixture(3);
  const read: any = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, controller.signal);
  const first: any = await projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: read.revision, oldText: 'old', newText: 'first' }, controller.signal);
  expect(first.revision).not.toBe(read.revision);
  await projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: first.revision, oldText: 'first', newText: 'second' }, controller.signal);
  await expect(projects.execute(chat, 'patch_project_file', { path: 'note.txt', revision: first.revision, oldText: 'second', newText: 'stale' }, controller.signal)).rejects.toThrow('changed since');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('second');
});

it('retrieves the exact saved task contract without project notes or source rereads', async () => {
  const { store, project, projects } = await fixture(3);
  let calls = 0;
  const criterion = { text: 'Inspect the local project', status: 'not_run', verification: 'inspection', evidenceIds: [] };
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    if (calls === 1) return { text: '', tools: [{ id: 'contract', name: 'update_project_task', arguments: { requirements: [criterion], remaining: 'Inspect sources' } }] };
    if (calls === 2) {
      expect(input.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'read_project_task' }) })]));
      return { text: '', tools: [{ id: 'task', name: 'read_project_task', arguments: {} }] };
    }
    const result = JSON.parse((input.messages.at(-1) as any).content);
    expect(result.requirements[0]).toMatchObject(criterion);
    expect(result.remaining).toBe('Inspect sources');
    expect(result.objective).toContain('Inspect this project');
    return { text: 'Inspection still needs to run.', tools: [] };
  } } as unknown as ModelProvider;
  const id = await service(store, provider, projects).send(null, profile, 'Inspect this project', [], undefined, project.id);
  expect(store.chat(id).projectHandoff?.requirements).toHaveLength(1);
});

it('requires model compatibility when a follow-up introduces browser inference',async()=>{
  const {store,project,projects,root}=await fixture(3);let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    calls++;
    if(calls===1)return {text:'',tools:[{id:'read',name:'read_project_file',arguments:{path:'note.txt'}}]};
    if(calls===2){const result=JSON.parse((input.messages.at(-1) as any).content);return {text:'',tools:[{id:'contract',name:'update_project_task',arguments:{requirements:[{text:'Inspect the initial note',status:'passed',verification:'inspection',evidenceIds:[result.evidenceId]}],remaining:''}}]};}
    if(calls===4)return {text:'',tools:[{id:'edit',name:'edit_project_file',arguments:{path:'note.txt',expectedHash:hash('old'),content:'unauthorized model implementation'}}]};
    return {text:'Saved findings.',tools:[]};
  }} as unknown as ModelProvider;
  const chats=service(store,provider,projects);
  const id=await chats.send(null,profile,'Inspect the note',[],undefined,project.id);
  await chats.send(id,profile,'Now implement GGUF inference in the browser.');
  expect(store.chat(id).projectHandoff?.requiresModelVerification).toBe(true);
  expect(store.chat(id).messages.at(-1)?.sourceEvidence?.[0].result).toContain('MODEL_CONTRACT_REQUIRED');
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('old');
});

it('finalizes canceled attempts and invalidates verification when an interrupted edit may have written',async()=>{
  const {store,project,projects,root}=await fixture(3);let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    calls++;
    if(calls===1)return {text:'',tools:[{id:'read',name:'read_project_file',arguments:{path:'note.txt'}}]};
    if(calls===2){const result=JSON.parse((input.messages.at(-1) as any).content);return {text:'',tools:[{id:'contract',name:'update_project_task',arguments:{requirements:[{text:'The note has been checked',status:'passed',verification:'inspection',evidenceIds:[result.evidenceId]}],remaining:''}}]};}
    if(calls===4)return {text:'',tools:[{id:'edit',name:'edit_project_file',arguments:{path:'note.txt',expectedHash:hash('old'),content:'written before stop'}}]};
    return {text:'Saved findings.',tools:[]};
  }} as unknown as ModelProvider;
  const chats=service(store,provider,projects);
  const id=await chats.send(null,profile,'Inspect the note',[],undefined,project.id);
  const execute=projects.execute.bind(projects);
  vi.spyOn(projects,'execute').mockImplementation(async(chat,name,args,signal)=>{
    const result=await execute(chat,name,args,signal);
    if(name==='edit_project_file'){chats.stop(chat.id);signal.throwIfAborted();}
    return result;
  });
  await chats.send(id,profile,'Update the note');
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('written before stop');
  expect(store.chat(id).projectHandoff?.requirements[0].status).toBe('not_run');
  expect(store.chat(id).messages.at(-1)?.toolActivity?.[0]).toMatchObject({status:'failed',completedAt:expect.any(Number)});
  expect(store.chat(id).messages.at(-1)?.delivery?.status).toBe('stopped');
});

it('accepts a known revision in the legacy hash field without accepting arbitrary tokens',async()=>{
  const {projects,chat,controller,root}=await fixture();const read:any=await projects.execute(chat,'read_project_file',{path:'note.txt'},controller.signal);
  await projects.execute(chat,'patch_project_file',{path:'note.txt',expectedHash:read.revision,oldText:'old',newText:'updated'},controller.signal);
  expect(await fs.readFile(path.join(root,'note.txt'),'utf8')).toBe('updated');
  await expect(projects.execute(chat,'patch_project_file',{path:'note.txt',expectedHash:randomUUID(),oldText:'updated',newText:'bad'},controller.signal)).rejects.toThrow('Unknown read revision');
});

it('runs confined level 2 build and file commands without requesting approval', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(2);
  const execute = vi.fn(async () => ({ exitCode: 0, output: 'created', timedOut: false, confined: true }));
  const execution = { probe: async () => ({ available: true, version: '1.0.1' }), execute } as unknown as ProjectExecutionAdapter;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'command-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  await projects.execute(chat, 'run_project_command', { command: 'mkdir src && echo hello>src/new.txt' }, controller.signal);
  await projects.execute(chat, 'run_project_command', { command: 'npm run build', network: 'allow' }, controller.signal);
  await projects.execute(chat, 'edit_project_file', { path: 'nested/new.txt', expectedHash: null, content: 'created' }, controller.signal);
  expect(await fs.readFile(path.join(root, 'nested/new.txt'), 'utf8')).toBe('created');
  expect(execute).toHaveBeenCalledTimes(2);
  expect(approvals.snapshot()).toEqual([]);
});

it('runs structured scripts through the real project tool interface', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(3);
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused-runtime'), path.join(directory, 'scratch'));
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'process-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const result: any = await projects.execute(chat, 'run_project_process', { executable: process.execPath, args: ['-'], stdin: 'console.log("real structured script [data-view=]")' }, controller.signal);
  expect(result).toMatchObject({ exitCode: 0, projectChanged: false }); expect(result.output).toContain('[data-view=]');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('old');
});

it('detects command mutations in long single-line source without relying on paginated reads', async () => {
  const { root, directory, store, chat, approvals, controller } = await fixture(3);
  await fs.writeFile(path.join(root, 'long.js'), '// ' + 'x'.repeat(21000));
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused'), path.join(directory, 'scratch'));
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'long-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  const result: any = await projects.execute(chat, 'run_project_process', { executable: process.execPath, args: ['-'], stdin: 'require("fs").appendFileSync("long.js"," changed");process.exit(1)' }, controller.signal);
  expect(result).toMatchObject({ exitCode: 1, projectChanged: true });
});

it('records fresh failure evidence for repeated commands and blocks unverified completion', async () => {
  const { directory, store, projects, project } = await fixture(3);
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused'), path.join(directory, 'scratch'));
  const tools = new ProjectTools(store, new ChatApprovals(() => {}), new ProjectWorktreeService(path.join(directory, 'evidence-workspaces')), undefined, { execution });
  let calls = 0; const command = `"${process.execPath}" -e "process.exit(1)"`;
  const provider = { chat: async () => {
    calls++;
    if(calls===1)return {text:'',tools:[{id:'initial',name:'update_project_task',arguments:{requirements:[{text:'Tests pass',status:'not_run',verification:'command',evidenceIds:[]}],remaining:'Run checks'}}]};
    if (calls <= 3) return { text: '', tools: [{ id: `check-${calls}`, name: 'run_project_command', arguments: { command } }] };
    if (calls === 4) return { text: '', tools: [{ id: 'contract', name: 'update_project_task', arguments: { requirements: [{ text: 'Tests pass', status: 'failed', verification: 'command', evidenceIds: [] }], remaining: 'Fix failing command' } }] };
    return { text: 'The command failed; changes are not verified.', tools: [] };
  } } as unknown as ModelProvider;
  const completed = vi.fn();
  const chats = new ChatService(store, provider, () => {}, () => false, undefined, undefined, tools, projectTestRuntime(provider), undefined, completed);
  const id = await chats.send(null, profile, 'Check the project', [], undefined, project.id);
  const saved = store.chat(id), evidence = saved.messages.at(-1)?.sourceEvidence?.filter(item => item.tool === 'run_project_command') ?? [];
  expect(evidence).toHaveLength(2); expect(evidence[0].id).not.toBe(evidence[1].id);
  expect(evidence.every(item => JSON.parse(item.result).exitCode === 1)).toBe(true);
  expect(saved.messages.at(-1)?.toolActivity?.filter(item=>item.name==='run_project_command').every(item => item.status === 'failed')).toBe(true);
  expect(saved.status).toBe('failed'); expect(saved.error).toContain('unresolved blocker'); expect(completed).not.toHaveBeenCalled();
  expect(projects).toBeTruthy();
});

it('preserves stopped task context without replaying actions and invalidates changed sources', async () => {
  const { store, projects, project, root } = await fixture(); let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    if (calls === 1) return { text: '', tools: [{ id: 'read', name: 'read_project_file', arguments: { path: 'note.txt' } }] };
    if (calls === 2) { chats.stop(chats.activeId!); input.signal.throwIfAborted(); }
    expect(JSON.stringify(input.messages)).toContain('Saved task handoff');
    expect(JSON.stringify(input.messages)).toContain('Original coding request');
    return { text: 'The earlier read is preserved; source changed, so prior verification is unknown.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = service(store, provider, projects);
  const id = await chats.send(null, profile, 'Original coding request', [], undefined, project.id);
  expect(store.chat(id).status).toBe('stopped'); expect(store.chat(id).projectHandoff?.reads).toHaveLength(1);
  await fs.writeFile(path.join(root, 'note.txt'), 'user changed source');
  await chats.send(id, profile, 'Resume');
  const resumed = store.chat(id); expect(resumed.status).toBe('idle'); expect(resumed.projectHandoff?.reads).toHaveLength(0);
  expect(resumed.messages.at(-1)?.toolActivity).toBeUndefined();
});

it('drops obsolete edit snapshots so newly verified work stays verified on an unchanged follow-up', async () => {
  const { projects, chat, root, controller } = await fixture();
  chat.projectHandoff = { requirements: [{ text: 'Source is checked', status: 'passed', verification: 'inspection', evidenceIds: [] }], snapshots: [{ path: 'note.txt', hash: hash('old')! }], reads: [], checks: [], changedPaths: ['note.txt'], completedSteps: [], remaining: '', updatedAt: Date.now() };
  await fs.writeFile(path.join(root, 'note.txt'), 'external update');
  await projects.prepare(chat, controller.signal);
  expect(chat.projectHandoff.snapshots).toEqual([]); expect(chat.projectHandoff.requirements[0].status).toBe('not_run');
  chat.projectHandoff.requirements[0].status = 'passed';
  await projects.prepare(chat, controller.signal);
  expect(chat.projectHandoff.requirements[0].status).toBe('passed');
});

it('delivers a disposable project through the real SDK, process and browser, then continues without replay', async () => {
  const { directory, root, store, project, approvals } = await fixture(3);
  const execution = new ProjectExecutionAdapter(path.join(directory, 'unused-runtime'), path.join(directory, 'scratch'));
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'delivery-workspaces')), undefined, { execution });
  await fs.writeFile(path.join(root,'index.html'),'<textarea id="question"></textarea><p id="reply"></p><script>question.onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();reply.textContent="Observed: "+question.value}}</script>');
  const server=createServer(async (_request,response)=>{response.setHeader('content-type','text/html');response.end(await fs.readFile(path.join(root,'index.html')))});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const policy=new WebPolicy();
  const browser=new ChatBrowser(path.resolve('node_modules'),path.resolve('.build-resources/browser-runtime'),policy,undefined,undefined,()=>true);
  cleanups.push(()=>browser.dispose());
  const capabilities={beginTurn:()=>{},endTurn:async()=>{},handles:(name:string)=>name.startsWith('browser_'),execute:async(id:string,name:string,args:any,signal:AbortSignal)=>{
    policy.allowLocalOrigin(id,url);
    if(name==='browser_open')return browser.open(id,args.url,signal);
    if(name==='browser_fill')return browser.fill(id,args.selector,args.text,args.submit,signal,args.responseSelector);
    return browser.read(id,0,signal,args.selector);
  }} as any;
  let calls = 0;
  const criterion = { text: 'note.txt is updated and the script check passes', verification: 'command', evidenceIds: [] as string[] };
  const interaction={text:'The page receives a question and displays the response',verification:'browser',evidenceIds:[] as string[]};
  let commandEvidence='';
  const provider = { chat: async (input: ChatInput) => {
    const step = ++calls;
    const tool = (name: string, args: unknown) => ({ text: '', tools: [{ id: `delivery-${step}`, name: `mcp__mercury__${name}`, arguments: args }] });
    const last: any = input.messages.filter((item: any) => item.role === 'tool').at(-1);
    const result = last ? JSON.parse(last.content) : undefined;
    if (step === 1) return tool('update_project_task', { requirements: [{ ...criterion, status: 'not_run' },{...interaction,status:'not_run'}], remaining: 'Patch and check' });
    if (step === 2) return tool('read_project_file', { path: 'note.txt' });
    if (step === 3) return tool('patch_project_file', { path: 'note.txt', revision: result.revision, oldText: 'old', newText: 'updated' });
    if (step === 4) return tool('run_project_process', { executable: process.execPath, args: ['-'], stdin: 'if(require("fs").readFileSync("note.txt","utf8")!=="updated")process.exit(1);console.log("verified updated source")' });
    if (step === 5) { expect(result.exitCode).toBe(0);commandEvidence=result.evidenceId;return tool('browser_open',{url}); }
    if (step === 6) return tool('browser_fill',{selector:'#question',text:'Test question',submit:true,responseSelector:'#reply'});
    if (step === 7) return tool('browser_read',{selector:'#reply'});
    if (step === 8) { expect(result.selected.text).toBe('Observed: Test question');return tool('update_project_task',{requirements:[{...criterion,status:'passed',evidenceIds:[commandEvidence]},{...interaction,status:'passed',evidenceIds:[result.evidenceId]}],remaining:''}); }
    const text = 'Updated note.txt. The verification script passed.'; input.onText?.(text); return { text, tools: [] };
  } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(directory, 'agent-sessions'), { executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe') });
  cleanups.push(() => runtime.shutdown());
  const chats = new ChatService(store, provider, () => {}, () => false, undefined, capabilities, projects, runtime);
  const id = await chats.send(null, profile, 'Update note.txt, check the resulting file and report the result.', [], undefined, project.id);
  expect(store.chat(id), store.chat(id).error).toMatchObject({ status: 'idle', projectHandoff: { requirements: [{ status: 'passed' },{status:'passed'}] } });
  expect(store.chat(id).messages.at(-1)?.verification).toBe('passed');
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('updated');
  const originalSession = store.chat(id).projectRuntime?.sessionId;
  await chats.send(id, profile, 'Summarize the saved result; do not redo work.');
  expect(store.chat(id).projectRuntime?.sessionId).toBe(originalSession);
  expect(calls).toBe(10);
}, 60000);

it.each(process.env.MERCURY_LIVE_MXC === '1' ? [2, 3] as const : [3] as const)('routes actual level %s Git commands to Mercury history without touching the personal repository', async mode => {
  const { root, directory, store, chat, approvals, controller } = await fixture(mode, true);
  const original = (...args: string[]) => promisify(execFile)('git', ['-C', root, ...args], { windowsHide: true });
  const beforeHead = (await original('rev-parse', 'HEAD')).stdout;
  const beforeIndex = await fs.readFile(path.join(root, '.git', 'index'));
  const beforeConfig = await fs.readFile(path.join(root, '.git', 'config'));
  const execution = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(directory, 'execution'));
  cleanups.push(() => execution.shutdown());
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'command-workspaces')), undefined, { execution });
  await projects.prepare(chat, controller.signal);
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'shell checkpoint' }, controller.signal);
  const result = await projects.execute(chat, 'run_project_command', { command: 'git add note.txt && git commit -m Mercury-shell-checkpoint' }, controller.signal);
  expect(result).toMatchObject({ exitCode: 0, timedOut: false, confined: mode === 2 });
  expect((await original('rev-parse', 'HEAD')).stdout).toBe(beforeHead);
  expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(beforeIndex);
  expect(await fs.readFile(path.join(root, '.git', 'config'))).toEqual(beforeConfig);
  const alternate = (...args: string[]) => promisify(execFile)('git', [`--git-dir=${path.join(root, '.mercury', 'git')}`, `--work-tree=${root}`, ...args], { windowsHide: true });
  expect((await alternate('show', 'HEAD:note.txt')).stdout).toBe('shell checkpoint');
  expect((await alternate('log', '-1', '--format=%an|%ae|%cn|%ce')).stdout.trim()).toBe('Mercury AI|ai@mercury.local|Mercury AI|ai@mercury.local');
  expect((await alternate('remote')).stdout).toBe('');
  expect(approvals.snapshot()).toEqual([]);
});

it('skips startup rebuilds and writes changed diagrams only after the response before committing', async () => {
  const { directory, root, store, chat, approvals, controller } = await fixture(3, true);
  const refresh = vi.fn();
  const updateChanged = vi.fn(async (_root: string, paths: string[]) => {
    expect(paths).toEqual(['note.txt']);
    await fs.mkdir(path.join(root, '.mercury/architecture/generated'), { recursive: true });
    await fs.writeFile(path.join(root, '.mercury/architecture/generated/note.mmd'), 'flowchart LR\nNote --> Content');
  });
  const maps = { hasExistingDiagrams: vi.fn(async () => true), refresh, updateChanged } as unknown as ProjectMaps;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'fast-workspaces')), undefined, { maps });
  await projects.prepare(chat, controller.signal);
  expect(refresh).not.toHaveBeenCalled();
  await projects.execute(chat, 'edit_project_file', { path: 'note.txt', expectedHash: hash('old'), content: 'updated' }, controller.signal);
  expect(updateChanged).not.toHaveBeenCalled();
  await projects.commitResponse(chat, controller.signal);
  expect(updateChanged).toHaveBeenCalledTimes(1);
  const git = (...args: string[]) => promisify(execFile)('git', [`--git-dir=${path.join(root, '.mercury', 'git')}`, `--work-tree=${root}`, '-C', root, ...args], { windowsHide: true });
  expect(await fs.readFile(path.join(root, '.mercury/architecture/generated/note.mmd'), 'utf8')).toContain('Note --> Content');
  expect((await git('ls-files', '.mercury')).stdout).toBe('');
  expect((await git('show', 'HEAD:note.txt')).stdout).toBe('updated');
});

it('initializes missing diagrams once and skips initialization on the next response', async () => {
  const { directory, store, chat, approvals, controller } = await fixture(3, true);
  let present = false;
  const refresh = vi.fn(async () => { present = true; });
  const maps = { hasExistingDiagrams: vi.fn(async () => present), refresh } as unknown as ProjectMaps;
  const projects = new ProjectTools(store, approvals, new ProjectWorktreeService(path.join(directory, 'initial-workspaces')), undefined, { maps });
  await projects.prepare(chat, controller.signal);
  await projects.prepare(chat, controller.signal);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('requires an exact outside read in level 1, and denies instead of reading when rejected', async () => {
  const { directory, projects, chat, approvals, controller } = await fixture(1);
  const outside = path.join(directory, 'private.txt'); await fs.writeFile(outside, 'private');
  const pending = projects.execute(chat, 'read_project_file', { path: outside }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0]).toMatchObject({ projectId: chat.projectId, kind: 'read', paths: [outside] });
  approvals.answer(approvals.snapshot()[0].id, false);
  await expect(pending).rejects.toThrow(/denied/);
});

it('allows whole-device reads in level 2 but requires outside-write approval', async () => {
  const { directory, projects, chat, approvals, controller } = await fixture(2);
  const outside = path.join(directory, 'outside.txt'); await fs.writeFile(outside, 'outside');
  expect(await projects.execute(chat, 'read_project_file', { path: outside }, controller.signal)).toMatchObject({ hash: hash('outside') });
  const pending = projects.execute(chat, 'edit_project_file', { path: outside, expectedHash: hash('outside'), content: 'approved' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  expect(approvals.snapshot()[0].details).toContain('proposedContent');
  expect(approvals.snapshot()[0].details).toContain('approved');
  approvals.answer(approvals.snapshot()[0].id, true); await pending;
  expect(await fs.readFile(outside, 'utf8')).toBe('approved');
});

it('invalidates an awaiting approval when permissions change', async () => {
  const { directory, projects, chat, approvals, controller, project, store } = await fixture(1);
  const outside = path.join(directory, 'outside.txt'); await fs.writeFile(outside, 'unchanged');
  const pending = projects.execute(chat, 'edit_project_file', { path: outside, expectedHash: hash('unchanged'), content: 'wrong' }, controller.signal);
  await expect.poll(() => approvals.snapshot().length).toBe(1);
  store.saveProject({ ...project, permissionMode: 2, policyRevision: 2 });
  approvals.answer(approvals.snapshot()[0].id, true);
  await expect(pending).rejects.toThrow(/permissions changed/);
  expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
});

it('does not search a project folder replaced by a junction to an outside folder', async () => {
  const { directory, root, projects, chat, controller } = await fixture(1);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.txt'), 'private content');
  await fs.rename(root, path.join(directory, 'original'));
  await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(projects.execute(chat, 'search_project_files', { query: 'private' }, controller.signal)).rejects.toThrow(/identity changed/);
});

it.each([1, 2] as const)('fails closed for commands and plugin execution in restricted mode %s', async mode => {
  const { directory, projects, chat, approvals, controller } = await fixture(mode);
  const marker = path.join(directory, 'never-created.txt');
  await expect(projects.execute(chat, 'run_project_command', { command: `echo unsafe > "${marker}"` }, controller.signal)).rejects.toThrow(/confinement/);
  await expect(projects.authorizePlugin(chat, 'plugin_call_tool', {}, controller.signal)).rejects.toThrow(/confinement/);
  expect(approvals.snapshot()).toEqual([]);
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('runs a full-access command and includes its actual verification result', async () => {
  const { projects, chat, controller } = await fixture(3);
  const output = await projects.execute(chat, 'run_project_command', { command: `"${process.execPath}" -e "process.stdout.write('verified')"` }, controller.signal);
  expect(output).toMatchObject({ exitCode: 0, output: 'verified' });
});

it('creates a Git safety commit after a successful project response', async () => {
  const { store, project, root, projects } = await fixture(3, true);
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (++calls === 1) return {text:'',tools:[{id:'contract',name:'update_project_task',arguments:{requirements:[{text:'The note contains the saved response',status:'not_run',verification:'inspection',evidenceIds:[]}],remaining:'Edit and inspect'}}]};
    if (calls === 2) return { text: '', tools: [{ id: 'edit', name: 'edit_project_file', arguments: { path: 'note.txt', expectedHash: hash('old'), content: 'saved by response' } }] };
    if (calls === 3) return { text: '', tools: [{ id: 'read', name: 'read_project_file', arguments: { path: 'note.txt' } }] };
    if (calls === 4) {
      const result = JSON.parse((input.messages.at(-1) as { content: string }).content);
      return { text: '', tools: [{ id: 'verify', name: 'update_project_task', arguments: { requirements: [{ text: 'The note contains the saved response', status: 'passed', verification: 'inspection', evidenceIds: [result.evidenceId] }], remaining: '' } }] };
    }
    return { text: 'Saved safely.', tools: [] };
  } } as unknown as ModelProvider;
  const completed = vi.fn();
  const chats = new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects, projectTestRuntime(provider), undefined, completed);
  const id = await chats.send(null, profile, 'Update the note', [], undefined, project.id);
  expect(completed).toHaveBeenCalledOnce();
  expect(completed).toHaveBeenCalledWith(expect.objectContaining({ id, projectId: project.id, status: 'idle' }));
  const git = (...args: string[]) => promisify(execFile)('git', [`--git-dir=${path.join(root, '.mercury', 'git')}`, `--work-tree=${root}`, '-C', root, ...args], { windowsHide: true });
  expect((await git('log', '-1', '--format=%s')).stdout).toMatch(/^Mercury: save response for /);
  expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('saved by response');
});

it('starts project conversations directly with Main, offers project reads to Subagent, and persists ownership', async () => {
  const { projects, store, project } = await fixture();
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    calls++;
    const names = (input.tools as any[]).map(tool => tool.function.name);
    if (calls === 1) {
      expect(input.messages.map(item => String((item as { content: string }).content)).join('\n')).toContain('PROJECT CODING CONTEXT');
      expect(names).toContain('edit_project_file');
      return { text: '', tools: [{ id: 'delegate', name: 'delegate_task', arguments: { task: 'Inspect note.txt', context: 'Read only note.txt.' } }] };
    }
    if (calls === 2) {
      expect(names).toContain('read_project_file'); expect(names).not.toContain('edit_project_file');
      return { text: 'The file is available for inspection.', tools: [] };
    }
    return { text: 'Ready to work on the project.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = service(store, provider, projects);
  const id = await chats.send(null, profile, 'Inspect the project', [], undefined, project.id);
  expect(store.chat(id)).toMatchObject({ projectId: project.id, status: 'idle', workspacePath: project.path });
  expect(calls).toBe(3);
  await expect(chats.send(id, profile, 'Move ownership', [], undefined, randomUUID())).rejects.toThrow(/different project/);
});

it('offers attachment reads but creates no generated chat files in project mode', async () => {
  const { directory, projects, store, project } = await fixture();
  const files = new ChatFiles(path.join(directory, 'attachments'), async () => Buffer.from(''), async () => '');
  const create = vi.spyOn(files, 'create');
  let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    const names = (input.tools as any[]).map(tool => tool.function.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('create_file');
    expect(names).not.toContain('create_pdf');
    if (++calls === 1) return { text: '', tools: [{ id: 'invented', name: 'create_file', arguments: { name: 'stockpile.txt', content: 'wrong destination' } }] };
    return { text: 'Use the project folder.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = new ChatService(store, provider, () => {}, () => false, files, undefined, projects, projectTestRuntime(provider));
  const id = await chats.send(null, profile, 'Create a file in the project', [], undefined, project.id);
  expect(create).not.toHaveBeenCalled();
  expect(store.chat(id).messages.flatMap(message => message.files ?? [])).toEqual([]);
});

it('keeps project tools unavailable to ordinary chats even if a model invents their names', async () => {
  const { projects, store } = await fixture(); let calls = 0;
  const provider = { chat: async (input: ChatInput) => {
    expect((input.tools as any[]).map(tool => tool.function.name)).not.toContain('read_project_file');
    return ++calls === 1 ? { text: '', tools: [{ id: 'invented', name: 'read_project_file', arguments: { path: 'note.txt' } }] } : { text: 'No project access in this chat.', tools: [] };
  } } as unknown as ModelProvider;
  const id = await new ChatService(store, provider, () => {}, () => false, undefined, undefined, projects).send(null, profile, 'Hello');
  expect(store.chat(id).projectId).toBeUndefined();
});

it('shares revisioned notes between project chats without copying their transcripts', async () => {
  const { projects, chat, controller } = await fixture();
  const updated = await projects.execute(chat, 'update_project_notes', { expectedRevision: 0, content: 'Use deterministic fixtures.' }, controller.signal);
  expect(updated).toMatchObject({ revision: 1, content: 'Use deterministic fixtures.' });
  await expect(projects.execute(chat, 'update_project_notes', { expectedRevision: 0, content: 'Stale' }, controller.signal)).rejects.toThrow(/changed/);
  expect(await projects.execute(chat, 'read_project_notes', {}, controller.signal)).toMatchObject({ revision: 1 });
});

it('runs independent project analyses three at once and associates results in request order', async () => {
  const { projects, store, project } = await fixture();
  const waiting: (() => void)[] = []; let live = 0, maximum = 0, mainCalls = 0;
  const provider = { chat: async (input: ChatInput) => {
    if (String((input.messages[0] as any).content).includes('read-only Subagent')) {
      live++; maximum = Math.max(maximum, live);
      const task = String((input.messages[1] as any).content);
      await new Promise<void>(resolve => waiting.push(resolve)); live--;
      return { text: `Findings: ${task}`, tools: [] };
    }
    if (++mainCalls === 1) return { text: '', tools: [0, 1, 2, 3].map(index => ({ id: `delegate-${index}`, name: 'delegate_task', arguments: { task: `Independent task ${index}`, context: 'Read-only review.' } })) };
    const results = input.messages.filter((item: any) => item.role === 'tool') as any[];
    expect(results.map(item => item.tool_call_id)).toEqual(['delegate-0', 'delegate-1', 'delegate-2', 'delegate-3']);
    return { text: 'All four independent reviews are complete.', tools: [] };
  } } as unknown as ModelProvider;
  const pending = service(store, provider, projects).send(null, profile, 'Review independent areas', [], undefined, project.id);
  await expect.poll(() => waiting.length).toBe(3);
  waiting[1](); await expect.poll(() => waiting.length).toBe(4);
  waiting[3](); waiting[2](); waiting[0]();
  const id = await pending;
  expect(maximum).toBe(3); expect(store.chat(id).status).toBe('idle');
});

it('cancels a project response when permission settings change', async () => {
  const { projects, store, project } = await fixture(3); let entered = false;
  const provider = { chat: async (input: ChatInput) => {
    entered = true;
    await new Promise<void>((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
    return { text: 'Must never finish.', tools: [] };
  } } as unknown as ModelProvider;
  const chats = service(store, provider, projects);
  const pending = chats.send(null, profile, 'Start work', [], undefined, project.id);
  await expect.poll(() => entered).toBe(true);
  store.saveProject({ ...project, permissionMode: 1, policyRevision: 2 }); chats.projectPolicyChanged(project.id);
  const id = await pending;
  expect(store.chat(id).status).toBe('stopped'); expect(store.chat(id).error).toContain('permissions changed');
});
