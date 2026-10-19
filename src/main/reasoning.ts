// Older local models put a leading <think> block in content instead of using
// the provider's separate reasoning field. Hold partial delimiters across chunks.
export class ReasoningStream {
  private phase: 'prefix' | 'thinking' | 'answer' = 'prefix';
  private buffer = '';
  constructor(private answer: (text: string) => void, private thinking: (text: string) => void) {}
  push(text: string): void {
    if (this.phase === 'answer') { if (text) this.answer(text); return; }
    this.buffer += text;
    if (this.phase === 'prefix') {
      const start = this.buffer.trimStart();
      if (start.startsWith('<think>')) {
        this.buffer = start.slice(7);
        this.phase = 'thinking';
      } else if ('<think>'.startsWith(start) && this.buffer.length < 64) return;
      else { this.phase = 'answer'; this.answer(this.buffer); this.buffer = ''; return; }
    }
    const close = this.buffer.indexOf('</think>');
    if (close >= 0) {
      if (close) this.thinking(this.buffer.slice(0, close));
      const remaining = this.buffer.slice(close + 8);
      this.buffer = ''; this.phase = 'answer';
      if (remaining) this.answer(remaining);
      return;
    }
    let held = 0;
    for (let length = 1; length < 8 && length <= this.buffer.length; length++) {
      if ('</think>'.startsWith(this.buffer.slice(-length))) held = length;
    }
    const ready = this.buffer.slice(0, this.buffer.length - held);
    this.buffer = this.buffer.slice(this.buffer.length - held);
    if (ready) this.thinking(ready);
  }
  finish(): void {
    if (this.buffer) (this.phase === 'thinking' ? this.thinking : this.answer)(this.buffer);
    this.buffer = '';
  }
}
