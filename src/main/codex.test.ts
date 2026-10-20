import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexRpc, CodexService } from './codex';
import type { ChatInput } from './providers';

const connection = { id: 'codex-account', provider: 'codex' as const, label: 'Codex', url: 'https://chatgpt.com' };
function fixture(override?: (message: any, reply: (result: any) => void, notify: (method: string, params: any) => void) => boolean) {
  const requests: any[] = [];
  const children: any[] = [];
  const launch = async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    children.push(child);
    child.stdin.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const message = JSON.parse(line); requests.push(message);
        if (message.id === undefined) continue;
        const reply = (result: any) => queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'));
        const notify = (method: string, params: any) => queueMicrotask(() => child.stdout.write(JSON.stringify({ method, params }) + '\n'));
        if (override?.(message, reply, notify)) continue;
        if (message.method === 'initialize') reply({});
        else if (message.method === 'account/read') reply({ account: { type: 'chatgpt', email: 'test@example.com' } });
        else if (message.method === 'account/login/start') { reply({ loginId: 'login', authUrl: 'https://auth.openai.com/authorize' }); setImmediate(() => notify('account/login/completed', { loginId: 'login', success: true })); }
        else if (message.method === 'model/list') reply({ data: [{ model: 'catalog-model', displayName: 'Catalog model', inputModalities: ['text', 'image'] }, { model: 'hidden', hidden: true }], nextCursor: null });
        else if (message.method === 'thread/start') reply({ thread: { id: 'thread' } });
        else if (message.method === 'turn/start') {
          reply({ turn: { id: 'turn' } });
          const text = JSON.stringify({ text: 'Answer', tools: [] });
          notify('item/agentMessage/delta', { threadId: 'thread', delta: text });
          notify('item/completed', { threadId: 'thread', item: { type: 'agentMessage', text } });
          notify('turn/completed', { threadId: 'thread', turn: { status: 'completed' } });
        } else reply({});
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { launch, children, requests };
}
const input = (): ChatInput => ({ profile: { provider: 'codex', connectionId: connection.id, model: 'catalog-model', contextLimit: 8192 }, messages: [{ role: 'user', content: 'Hello' }], signal: new AbortController().signal });

it('resolves missing Codex model windows while preferring reported account limits', async () => {
  const f = fixture((message, reply) => {
    if (message.method !== 'model/list') return false;
    reply({ data: [{ model: 'gpt-5.3-codex' }, { model: 'gpt-6.1-sol', contextWindow: 128_000 }] });
    return true;
  });
  const models = await new CodexService('C:/test/codex', async () => {}, f.launch).discover(connection);
  expect(models[0]).toMatchObject({ contextLimit: 400_000, contextLimitSource: 'published' });
  expect(models[1]).toMatchObject({ contextLimit: 128_000, contextLimitSource: 'provider' });
});

it('uses Codex-managed browser login and discovers a separate model catalog', async () => {
  const f = fixture(); const open = vi.fn(async () => {});
  const service = new CodexService('C:/test/codex', open, f.launch);
  expect(await service.signIn()).toMatchObject({ provider: 'codex', id: 'codex-account', label: 'Codex · test@example.com' });
  expect(open).toHaveBeenCalledWith('https://auth.openai.com/authorize');
  expect(await service.discover(connection)).toEqual([expect.objectContaining({ provider: 'codex', id: 'catalog-model', visionCapable: true })]);
  await service.disconnect();
  expect(f.requests.some(item => item.method === 'account/logout')).toBe(true);
  expect(f.children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
});

it('supports cancellation and rejects concurrent sign-ins without opening another browser', async () => {
  let opened!: () => void; const ready = new Promise<void>(resolve => { opened = resolve; });
  const f = fixture((message, reply) => { if (message.method !== 'account/login/start') return false; reply({ loginId: 'login', authUrl: 'https://auth.openai.com/authorize' }); return true; });
  const service = new CodexService('C:/test/codex', async () => opened(), f.launch);
  const pending = service.signIn(); await ready;
  await expect(service.signIn()).rejects.toThrow(/already open/);
  service.cancelSignIn();
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(f.requests.some(item => item.method === 'account/login/cancel')).toBe(true);
});

it('rejects untrusted sign-in URLs and signed-out catalogs', async () => {
  const f = fixture((message, reply) => {
    if (message.method === 'account/login/start') { reply({ loginId: 'login', authUrl: 'https://example.com' }); return true; }
    if (message.method === 'account/read') { reply({ account: null }); return true; }
    return false;
  });
  const open = vi.fn(); const service = new CodexService('C:/test/codex', open, f.launch);
  await expect(service.signIn()).rejects.toThrow(/unexpected sign-in/);
  expect(open).not.toHaveBeenCalled();
  await expect(service.discover(connection)).rejects.toThrow(/signed out/);
});

it('completes structured inference and carries images without exposing Codex-native tools', async () => {
  const f = fixture(); const service = new CodexService('C:/test/codex', async () => {}, f.launch);
  const request = input(); const onText = vi.fn(); request.onText = onText;
  request.messages = [{ role: 'user', content: 'See this', images: [{ mimeType: 'image/png', data: 'pixels' }] }];
  expect(await service.chat(request)).toEqual({ text: 'Answer', tools: [] });
  expect(onText).toHaveBeenCalledWith('Answer');
  expect(f.requests.find(item => item.method === 'thread/start').params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'untrusted', config: { model_context_window: request.profile.contextLimit } });
  const turn = f.requests.find(item => item.method === 'turn/start').params;
  expect(turn.input[1]).toEqual({ type: 'image', url: 'data:image/png;base64,pixels' });
  expect(turn.outputSchema.properties.tools).toBeDefined();
});

it('returns offered tool requests to Mercury without executing them', async () => {
  const f = fixture((message, reply, notify) => {
    if (message.method !== 'turn/start') return false;
    reply({});
    notify('item/completed', { threadId: 'thread', item: { type: 'agentMessage', text: JSON.stringify({ text: '', tools: [{ name: 'read_file', arguments: '{"id":"file"}' }] }) } });
    notify('turn/completed', { threadId: 'thread', turn: { status: 'completed' } });
    return true;
  });
  const service = new CodexService('C:/test/codex', async () => {}, f.launch);
  const request = { ...input(), tools: [{ type: 'function', function: { name: 'read_file' } }] };
  expect((await service.chat(request)).tools[0]).toMatchObject({ name: 'read_file', arguments: { id: 'file' } });
  await expect(service.chat(input())).rejects.toThrow(/unoffered tool/);
});

it.each(['failed', 'interrupted'])('does not report %s Codex turns as success', async status => {
  const f = fixture((message, reply, notify) => { if (message.method !== 'turn/start') return false; reply({}); notify('turn/completed', { threadId: 'thread', turn: { status } }); return true; });
  await expect(new CodexService('C:/test/codex', async () => {}, f.launch).chat(input())).rejects.toThrow(status);
});

it('stops the isolated process on cancellation and rejects unexpected native actions', async () => {
  const controller = new AbortController();
  const f = fixture((message, reply) => { if (message.method !== 'turn/start') return false; reply({}); controller.abort(new Error('Stopped')); return true; });
  await expect(new CodexService('C:/test/codex', async () => {}, f.launch).chat({ ...input(), signal: controller.signal })).rejects.toThrow('Stopped');
  const native = fixture((message, reply, notify) => { if (message.method !== 'turn/start') return false; reply({}); notify('item/started', { threadId: 'thread', item: { type: 'commandExecution' } }); return true; });
  await expect(new CodexService('C:/test/codex', async () => {}, native.launch).chat(input())).rejects.toThrow(/native tool action/);
});

it('rejects pending RPCs on process loss and enforces request timeouts', async () => {
  const f = fixture(() => true); const child = await f.launch(); const rpc = new CodexRpc(child);
  const pending = rpc.request('account/read'); child.emit('exit', 1);
  await expect(pending).rejects.toThrow(/exited/);
  const timeout = new CodexRpc(await f.launch());
  await expect(timeout.request('initialize', {}, 1)).rejects.toThrow(/did not respond/);
  timeout.close();
});
