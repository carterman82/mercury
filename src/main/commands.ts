import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CommandRequest } from '../shared/types';

export interface CommandDecision { allow: boolean; remember: boolean; }

export class CommandGate {
  private pending: { request: CommandRequest; resolve: (decision: CommandDecision) => void } | null = null;
  private remembered = new Set<string>();
  constructor(private onPending: (request: CommandRequest | null) => void) {}
  private key(command: string, cwd: string): string { return `${cwd}\0${command}`; }
  async ask(command: string, cwd: string, signal: AbortSignal): Promise<boolean> {
    if (this.remembered.has(this.key(command, cwd))) return true;
    if (this.pending) throw new Error('Another command is awaiting approval.');
    const request = { id: randomUUID(), command, cwd };
    const decision = await new Promise<CommandDecision>(resolve => {
      this.pending = { request, resolve };
      this.onPending(request);
      signal.addEventListener('abort', () => this.answer(request.id, false, false), { once: true });
    });
    if (decision.allow && decision.remember) this.remembered.add(this.key(command, cwd));
    return decision.allow;
  }
  answer(id: string, allow: boolean, remember: boolean): void {
    if (!this.pending || this.pending.request.id !== id) throw new Error('Command request is no longer pending.');
    const pending = this.pending;
    this.pending = null;
    this.onPending(null);
    pending.resolve({ allow, remember });
  }
  cancel(): void { if (this.pending) this.answer(this.pending.request.id, false, false); }
}

export function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    let output = '';
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-40_000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const stop = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(stop, 120_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve({ exitCode: code, output }); });
  });
}
