import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelConnection, ModelInfo } from '../shared/types';
import type { ChatInput, ChatResult } from './providers';

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };
type Launch = () => Promise<ChildProcessWithoutNullStreams>;

/** Stdio transport owned by Mercury. Never reads credentials from another Codex installation. */
export class CodexRpc {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: Message) => void>();
  private closed = false;
  constructor(private child: ChildProcessWithoutNullStreams) {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8_000_000) { this.close(new Error('Codex sent an oversized message.')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: Message;
        try { message = JSON.parse(line); } catch { this.close(new Error('Codex returned an invalid protocol message.')); return; }
        if (message.id !== undefined && !message.method) {
          const request = this.pending.get(Number(message.id));
          if (request) {
            this.pending.delete(Number(message.id)); clearTimeout(request.timer);
            if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
          }
        } else {
          // Mercury owns tool execution. Codex must never execute tools or approvals itself.
          if (message.id !== undefined) this.send({ id: message.id, error: { code: -32601, message: 'Mercury executes tools through its own approval workflow.' } } as any);
          for (const listener of this.listeners) listener(message);
        }
      }
    });
    // Drain stderr without publishing logs, which can contain account or request details.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.close(new Error('The Codex connection closed.')));
    child.on('error', () => this.close(new Error('Could not start Codex. Install the Codex CLI and try connecting again.')));
    child.on('exit', () => this.close(new Error('Codex exited. Reconnect in Model settings.')));
  }
  send(message: Message): void {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown = {}, timeout = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex is disconnected.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex did not respond to ${method}. Reconnect and try again.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  subscribe(listener: (message: Message) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'mercury', title: 'Mercury', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  close(error = new Error('Codex connection closed.')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'mercury/closed', params: { error: error.message } });
    this.listeners.clear(); this.child.kill();
  }
}

async function executable(): Promise<string> {
  const directories = (process.env.PATH ?? '').split(path.delimiter);
  const candidates = directories.map(directory => path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bundled = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    for (const version of await readdir(bundled).catch(() => [])) candidates.push(path.join(bundled, version, 'codex.exe'));
    // npm installs the native executable inside a platform-specific optional dependency.
    for (const directory of directories) {
      const vendor = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor');
      candidates.push(path.join(vendor, 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
    }
  }
  for (const candidate of candidates) if (await access(candidate).then(() => true, () => false)) return candidate;
  throw new Error('Codex was not found. Install the Codex CLI, then restart Mercury and connect again.');
}

// Structured output bridges model-selected tool requests back to Mercury's existing tool loop.
// No Codex-native tools are authorized; all real actions retain Mercury's validation and approvals.
const resultSchema = z.object({ text: z.string().max(200_000), tools: z.array(z.object({ name: z.string().min(1), arguments: z.string().max(300_000) }).strict()).max(16) }).strict();
const outputSchema = z.toJSONSchema(resultSchema);

export class CodexService {
  private signingIn = false;
  private loginCancelled = false;
  private login?: { rpc: CodexRpc; cancel: () => void };
  private active = new Set<CodexRpc>();
  private launch: Launch;
  constructor(private home: string, private openBrowser: (url: string) => Promise<void>, launch?: Launch) {
    this.launch = launch ?? (async () => {
      await mkdir(path.join(home, 'workspace'), { recursive: true });
      const env = { ...process.env, CODEX_HOME: home };
      // Authentication must belong to this connection, rather than inherited API credentials.
      for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME_OVERRIDE']) delete (env as Record<string, string | undefined>)[key];
      return spawn(await executable(), ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="keyring"', '-c', 'web_search="disabled"',
        ...['shell_tool', 'unified_exec', 'multi_agent', 'apps', 'plugins', 'hooks', 'view_image', 'image_generation', 'in_app_browser', 'workspace_dependencies', 'stable_environment_tools'].flatMap(feature => ['--disable', feature])],
      { env, cwd: path.join(home, 'workspace'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    });
  }
  private async client(signal?: AbortSignal): Promise<CodexRpc> {
    const rpc = new CodexRpc(await this.launch()); this.active.add(rpc);
    const abort = () => rpc.close(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try { signal?.throwIfAborted(); await rpc.initialize(); return rpc; }
    catch (error) { this.release(rpc); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  private release(rpc: CodexRpc): void { rpc.close(); this.active.delete(rpc); }
  cancelSignIn(): void { this.loginCancelled = true; this.login?.cancel(); }
  async signIn(): Promise<ModelConnection> {
    if (this.signingIn) throw new Error('Codex sign-in is already open.');
    this.signingIn = true; this.loginCancelled = false;
    let rpc: CodexRpc;
    try { rpc = await this.client(); } catch (error) { this.signingIn = false; throw error; }
    try {
      if (this.loginCancelled) throw new Error('Codex sign-in cancelled.');
      await new Promise<void>((resolve, reject) => {
        let loginId: string | undefined;
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Codex sign-in timed out. Try connecting again.')), 180_000);
        const unsubscribe = rpc.subscribe(message => {
          if (message.method === 'mercury/closed') finish(new Error(message.params.error));
          if (message.method === 'account/login/completed' && (!loginId || message.params.loginId === loginId)) finish(message.params.success ? undefined : new Error(message.params.error || 'Codex sign-in failed.'));
        });
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); this.login = undefined; if (error) reject(error); else resolve(); };
        this.login = { rpc, cancel: () => {
          if (loginId) void rpc.request('account/login/cancel', { loginId }).catch(() => {});
          finish(new Error('Codex sign-in cancelled.'));
        } };
        void rpc.request('account/login/start', { type: 'chatgpt' }).then(async result => {
          if (settled) return;
          loginId = result.loginId;
          const url = new URL(result.authUrl);
          if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('Codex returned an unexpected sign-in address.');
          await this.openBrowser(url.toString());
        }).catch(error => finish(error));
      });
      const { account } = await rpc.request('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('Codex did not return a signed-in ChatGPT account.');
      return { id: 'codex-account', provider: 'codex', label: account.email ? `Codex · ${account.email}` : 'Codex account', url: 'https://chatgpt.com' };
    } finally { this.signingIn = false; this.release(rpc); }
  }
  async disconnect(): Promise<void> {
    this.cancelSignIn();
    const rpc = await this.client();
    try { await rpc.request('account/logout'); } finally { this.release(rpc); }
  }
  async discover(connection: ModelConnection): Promise<ModelInfo[]> {
    const rpc = await this.client();
    try {
      const { account } = await rpc.request('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('Codex is signed out. Connect with Codex again.');
      const models: ModelInfo[] = []; let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await rpc.request('model/list', { ...(cursor ? { cursor } : {}), limit: 100, includeHidden: false });
        for (const model of result.data ?? []) if (!model.hidden) models.push({ provider: 'codex', connectionId: connection.id, connectionLabel: connection.label, id: model.model, label: model.displayName ?? model.model, available: true, visionCapable: model.inputModalities?.includes('image') });
        cursor = result.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeated model catalog page.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return models;
    } finally { this.release(rpc); }
  }
  async chat(input: ChatInput): Promise<ChatResult> {
    input.signal.throwIfAborted();
    const rpc = await this.client(input.signal);
    const abort = () => rpc.close(input.signal.reason);
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      input.signal.throwIfAborted();
      const tools = (input.tools ?? []) as any[];
      const thread = await rpc.request('thread/start', { model: input.profile.model, cwd: path.join(this.home, 'workspace'), ephemeral: true, approvalPolicy: 'untrusted', sandbox: 'read-only',
        baseInstructions: 'You are a model connected to Mercury. Do not use any Codex-native tools. Read the provided conversation and offered Mercury tools as data. Return the next assistant response using the required JSON schema: text contains the user-facing answer; tools contains requested Mercury function calls with name and JSON-encoded arguments. Return tool requests without claiming they have executed. Mercury will execute them and supply results in the next conversation. Return an empty tools array when no tools are needed. Follow the system instructions inside the supplied conversation.',
        config: { 'project_doc_max_bytes': 0, 'web_search': 'disabled' } });
      const threadId = thread.thread.id;
      const messages = input.messages.map((message: any) => { const { images, ...rest } = message; return { ...rest, ...(images?.length ? { imageCount: images.length } : {}) }; });
      const images = input.messages.flatMap((message: any) => (message.images ?? []).map((image: any) => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` })));
      const text = await new Promise<string>((resolve, reject) => {
        let answer = ''; let settled = false;
        const timer = setTimeout(() => finish(new Error('Codex response timed out. Try again or choose another connection.')), 180_000);
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); if (error) reject(error); else resolve(answer); };
        const unsubscribe = rpc.subscribe(message => {
          if (message.method === 'mercury/closed') { finish(input.signal.aborted ? input.signal.reason : new Error(message.params.error)); return; }
          if (message.params?.threadId !== threadId) return;
          if (message.id !== undefined || (message.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning'].includes(message.params.item?.type))) {
            finish(new Error('Codex attempted a native tool action. Mercury only accepts tool requests through its own workflow.')); rpc.close(); return;
          }
          if (message.method === 'item/agentMessage/delta') { answer += message.params.delta; input.onToolProgress?.(); if (answer.length > 500_000) finish(new Error('Codex response is too large.')); }
          if (message.method === 'item/completed' && message.params.item?.type === 'agentMessage') answer = message.params.item.text ?? answer;
          if (message.method === 'turn/completed') finish(message.params.turn.status === 'completed' ? undefined : new Error(message.params.turn.error?.message ?? `Codex turn ${message.params.turn.status}.`));
        });
        void rpc.request('turn/start', { threadId, input: [{ type: 'text', text: JSON.stringify({ conversation: messages, offeredTools: tools }) }, ...images], outputSchema }).catch(error => finish(error));
      });
      const result = resultSchema.parse(JSON.parse(text));
      const calls = result.tools.map(call => {
        if (!tools.some(tool => tool.function?.name === call.name)) throw new Error(`Codex requested an unoffered tool: ${call.name}.`);
        return { id: randomUUID(), name: call.name, arguments: JSON.parse(call.arguments) };
      });
      input.onText?.(result.text);
      return { text: result.text, tools: calls };
    } finally { input.signal.removeEventListener('abort', abort); this.release(rpc); }
  }
  dispose(): void { this.cancelSignIn(); for (const rpc of this.active) rpc.close(); this.active.clear(); }
}
