/** A rolling inactivity deadline, never a total-duration budget. */
export class InactivityWatchdog {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  readonly signal = this.controller.signal;
  constructor(private milliseconds: number, private reason: Error) { this.progress(); }
  progress(): void {
    if (this.signal.aborted) return;
    this.pause();
    this.timer = setTimeout(() => this.controller.abort(this.reason), this.milliseconds);
    this.timer.unref?.();
  }
  pause(): void { clearTimeout(this.timer); this.timer = undefined; }
  dispose(): void { this.pause(); }
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop = () => {};
  const interrupted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', stop); }
}
