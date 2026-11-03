import { randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { ProjectExecutionAdapter, ProjectExecutionRequest } from './project-execution';
import type { WebPolicy } from './web-policy';
import { createHash } from 'node:crypto';
import { ToolFailure } from './tool-outcome';

type ServerEntry = { chatId: string; url: string; identity: string; startedAt: number; expiresAt: number; controller: AbortController; done: Promise<unknown>; output: string; running: boolean; error?: string };
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(250);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** Processes belong to the app, so ending a model response does not kill a preview. */
export class ProjectServers {
  private closed = false;
  private entries = new Map<string, ServerEntry>();
  private starts = new Map<string, Promise<unknown>>();
  constructor(private execution: ProjectExecutionAdapter, private web: WebPolicy) {}

  async start(chatId: string, request: ProjectExecutionRequest, port: number, signal: AbortSignal) {
    // Serialize port acquisition across chats too; a second request must recheck ownership.
    const key = String(port), previous = this.starts.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.launch(chatId, request, port, signal));
    this.starts.set(key, pending);
    try { return await pending; } finally { if (this.starts.get(key) === pending) this.starts.delete(key); }
  }
  private async launch(chatId: string, request: ProjectExecutionRequest, port: number, signal: AbortSignal) {
    if (this.closed) throw new Error('Project servers have shut down.');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a localhost port between 1024 and 65535.');
    signal.throwIfAborted();
    const identity = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const url = `http://127.0.0.1:${port}`;
    for (const [id, entry] of this.entries) if (entry.url === url && entry.running) {
      if (entry.chatId !== chatId || entry.identity !== identity) throw new Error(`Port ${port} belongs to another managed launch. Check owned server status; do not take it over.`);
      if (await listening(port)) { signal.throwIfAborted(); return { id, ...this.describe(entry), reused: true }; }
      throw new Error('The existing owned server is not responding. Inspect its status/output and stop it explicitly before restarting.');
    }
    if ([...this.entries.values()].filter(entry => entry.running).length >= 12) throw new Error('Stop an existing project server before starting another.');
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
    });
    signal.throwIfAborted();
    if (this.closed) throw new Error('Project servers have shut down.');
    const id = randomUUID(), controller = new AbortController();
    const entry: ServerEntry = { chatId, url, identity, startedAt: Date.now(), expiresAt: Date.now() + 3600000, controller, done: Promise.resolve() as Promise<unknown>, output: '', running: true };
    this.entries.set(id, entry);
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    entry.done = this.execution.execute({ ...request, loopback: true, timeoutMs: 3600000 }, controller.signal, (_stream, text) => { entry.output = (entry.output + text).slice(-40000); })
      .then(result => { entry.output = (entry.output + result.output).slice(-40000); if (result.exitCode) entry.error = `Server exited with code ${result.exitCode}.`; }, error => { if (!controller.signal.aborted) entry.error = String(error); })
      .finally(() => { entry.running = false; this.web.revokeLocalOrigin(chatId, entry.url); });
    try {
      const deadline = Date.now() + 30000;
      while (entry.running && Date.now() < deadline) {
        signal.throwIfAborted();
        const ready = await listening(port);
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        if (ready && entry.running) { this.web.allowLocalOrigin(chatId, entry.url); return { id, ...this.describe(entry), reused: false }; }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new ToolFailure('SERVER_START_FAILED', entry.error ?? `Server did not listen on ${entry.url}. Bind to 127.0.0.1 and use the requested port.`, { url: entry.url, output: entry.output.slice(-6000) });
    } catch (error) { controller.abort(); await entry.done; this.entries.delete(id); throw error; }
    finally { signal.removeEventListener('abort', stop); }
  }
  private describe(entry: ServerEntry) {
    return { url: entry.url, running: entry.running, output: entry.output, error: entry.error, expiresAt: entry.expiresAt,
      expiresInMinutes: Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 60000)) };
  }
  status(chatId: string, id: string): ReturnType<ProjectServers['describe']>;
  status(chatId: string, id?: string): ReturnType<ProjectServers['describe']> | { servers: ({ id: string } & ReturnType<ProjectServers['describe']>)[] };
  status(chatId: string, id?: string) {
    if (!id) return { servers: [...this.entries].filter(([, entry]) => entry.chatId === chatId).map(([id, entry]) => ({ id, ...this.describe(entry) })) };
    const entry = this.entries.get(id);
    if (!entry || entry.chatId !== chatId) throw new Error('Project server not found in this chat.');
    return this.describe(entry);
  }
  async stop(chatId: string, id: string) {
    this.status(chatId, id);
    const entry = this.entries.get(id)!;
    entry.controller.abort(); await entry.done; this.entries.delete(id);
    return { stopped: true };
  }
  stopChat(chatId: string): void { for (const entry of this.entries.values()) if (entry.chatId === chatId) { this.web.revokeLocalOrigin(chatId, entry.url); entry.controller.abort(); } }
  async shutdown() { this.closed = true; for (const entry of this.entries.values()) entry.controller.abort(); await Promise.all([...this.entries.values()].map(entry => entry.done)); this.entries.clear(); }
}
