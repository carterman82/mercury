import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';
import { ProjectTools } from './project-tools';
import { ProjectWorkers, projectOwnedPaths } from './project-workers';
import { ProjectWorktreeService } from './project-worktrees';
import { ChatApprovals } from './chat-approvals';
import { ClaudeProjectRuntime } from './project-agent-runtime';
import type { ChatThread } from '../shared/types';
import type { ChatInput, ModelProvider } from './providers';
import { projectTestRuntime } from './project-test-runtime';

const cleanup: (() => Promise<void>)[] = [];

it('lets a read-only research worker fetch public evidence without project writes', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mercury-worker-web-'));
  cleanup.push(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const store=new Store(path.join(root,'state.sqlite')); cleanup.push(async()=>store.close());
  const profile={provider:'ollama' as const,connectionId:'fixture',model:'research',contextLimit:16000};
  store.saveSettings({connections:[{id:'fixture',provider:'ollama',label:'Fixture',url:'http://127.0.0.1:11434'}],mainModel:profile,subagentModel:profile,plannerModel:null});
  const project={id:randomUUID(),name:'Research',path:root,permissionMode:3 as const,policyRevision:1};store.saveProject(project);
  const parent:ChatThread={id:randomUUID(),projectId:project.id,title:'Research',profile,messages:[],status:'idle',updatedAt:Date.now()};store.saveChat(parent);
  const tools=new ProjectTools(store,new ChatApprovals(()=>{}),new ProjectWorktreeService(path.join(root,'workspaces')));
  await tools.prepare(parent,new AbortController().signal);
  let calls=0;
  const provider={chat:async(input:ChatInput)=>{
    expect(JSON.stringify(input.tools)).toContain('web_fetch');
    if(++calls===1)return {text:'',tools:[{id:'fetch',name:'web_fetch',arguments:{url:'https://example.com/model'}}]};
    expect(JSON.stringify(input.messages)).toContain('Verified model metadata');
    return {text:'The model metadata is verified.',tools:[]};
  }} as unknown as ModelProvider;
  const web={handles:(name:string)=>name==='web_fetch',execute:async()=>({content:'Verified model metadata'})} as any;
  const workers=new ProjectWorkers(store,provider,projectTestRuntime(provider),tools,new ProjectWorktreeService(path.join(root,'workers')),()=>{},web);
  const assignment=await workers.start(parent,{kind:'investigation',task:'Research model',context:''},new AbortController().signal);
  await workers.wait(parent,[assignment.id]);
  expect(assignment.status).toBe('completed');expect(assignment.activity?.[0].name).toBe('web_fetch');expect(calls).toBe(2);
});
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
it.each(['../outside', 'src/../outside', '.git/config', 'src/*', 'C:\\outside', '.'])(
  'rejects unsafe worker ownership %s',
  (value) => {
    expect(() => projectOwnedPaths([value])).toThrow();
  },
);

it('runs two actual SDK coding workers in the shared checkout with owned paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-workers-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'existing.txt'), 'user content');
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', source, ...args], { windowsHide: true });
  await git('init');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('add', '.');
  await git('commit', '-m', 'baseline');
  const store = new Store(path.join(root, 'state.sqlite'));
  cleanup.push(async () => store.close());
  const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'worker-model', contextLimit: 16000 };
  store.saveSettings({
    connections: [{ id: 'fixture', provider: 'ollama', label: 'Test', url: 'http://127.0.0.1:11434' }],
    mainModel: profile,
    subagentModel: profile,
    plannerModel: null,
    projectWorkerConcurrency: 3,
  });
  const project = { id: randomUUID(), name: 'Test', path: source, permissionMode: 3 as const, policyRevision: 1 };
  store.saveProject(project);
  const chat: ChatThread = {
    id: randomUUID(),
    projectId: project.id,
    title: 'Test',
    profile,
    messages: [],
    status: 'idle',
    updatedAt: Date.now(),
  };
  store.saveChat(chat);
  const mainTrees = new ProjectWorktreeService(path.join(root, 'main'));
  const tools = new ProjectTools(store, new ChatApprovals(() => {}), mainTrees);
  const signal = new AbortController().signal;
  await tools.prepare(chat, signal);
  let active = 0,
    maximum = 0;
  let bothStarted!: () => void;
  const barrier = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const provider = {
    chat: async (input: ChatInput) => {
      const task = String((input.messages.find((message: any) => message.role === 'user') as any)?.content);
      const file = task.includes('write alpha') ? 'alpha.ts' : 'beta.ts';
      if (!input.messages.some((message: any) => message.role === 'tool')) {
        active++;
        maximum = Math.max(maximum, active);
        if (active === 2) bothStarted();
        await barrier;
        active--;
        return {
          text: '',
          tools: [
            {
              id: `write_${file}`,
              name: 'mcp__mercury__edit_project_file',
              arguments: { path: file, expectedHash: null, content: `export const value = '${file}';\n` },
            },
          ],
        };
      }
      return { text: `Created ${file}. Checks not run.`, tools: [] };
    },
  } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(root, 'sessions'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  cleanup.push(() => runtime.shutdown());
  const workers = new ProjectWorkers(
    store,
    provider,
    runtime,
    tools,
    new ProjectWorktreeService(path.join(root, 'workers')),
    () => {},
  );
  const alpha = await workers.start(
    chat,
    { kind: 'implementation', task: 'write alpha', context: '', ownedPaths: ['alpha.ts'] },
    signal,
  );
  const beta = await workers.start(
    chat,
    { kind: 'implementation', task: 'write beta', context: '', ownedPaths: ['beta.ts'] },
    signal,
  );
  await workers.wait(chat, undefined, signal);
  expect([alpha.status, beta.status], JSON.stringify(chat.projectAssignments)).toEqual(['completed', 'completed']);
  expect(maximum).toBe(2);
  expect(alpha.workspacePath).toBe(beta.workspacePath);
  expect(alpha.session?.runtime).toBe('claude-agent-sdk');
  expect(await fs.readFile(path.join(source, 'alpha.ts'), 'utf8')).toContain('alpha.ts');
  const reviewed: any = await workers.execute(chat, 'review_project_task', { id: alpha.id }, signal);
  await expect(
    workers.execute(chat, 'accept_project_task', { id: alpha.id, reviewToken: 'invalid' }, signal),
  ).rejects.toThrow();
  await workers.execute(chat, 'accept_project_task', { id: alpha.id, reviewToken: reviewed.token }, signal);
  for (const assignment of [beta]) {
    const review: any = await workers.execute(chat, 'review_project_task', { id: assignment.id }, signal);
    await expect(
      workers.execute(chat, 'accept_project_task', { id: assignment.id, reviewToken: alpha.id }, signal),
    ).rejects.toThrow('different worker');
    await workers.execute(chat, 'accept_project_task', { id: assignment.id, reviewToken: review.token }, signal);
  }
  const main = tools.getWorkspace(chat);
  expect(await fs.readFile(path.join(main.root, 'alpha.ts'), 'utf8')).toContain('alpha.ts');
  expect(main.root).toBe(source);
  expect(await fs.readFile(path.join(source, 'beta.ts'), 'utf8')).toContain('beta.ts');
  expect(await fs.readFile(path.join(source, 'existing.txt'), 'utf8')).toBe('user content');
}, 60000);
