export type ThinkingFailure = 'repetition' | 'budget' | 'timeout' | 'duration' | 'output';
export class ThinkingLimitError extends Error {
  constructor(readonly kind: ThinkingFailure, message = `Model ${kind} limit reached. Partial work is saved; no incomplete tool actions were executed.`) { super(message); }
}

export const LOCAL_GENERATION_LIMITS = {
  inactivityMs: 120_000, activeMs: 600_000, reasoningCharacters: 30_000,
  outputCharacters: 128_000, outputTokens: 8192,
};

/** Bounded stream inspection. Code is exempt from prose repetition, never budgets. */
export class GenerationGuard {
  private reasoning = new ThinkingGuard(LOCAL_GENERATION_LIMITS.reasoningCharacters);
  private prose = new ThinkingGuard(Infinity);
  private characters = 0;
  private pending = '';
  private fence = '';
  private lineStarted = false;
  answer(delta: string): void {
    this.output(delta);
    this.pending += delta;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      this.line(this.pending.slice(0, newline), true);
      this.pending = this.pending.slice(newline + 1);
    }
    // A possible closing delimiter needs its whole line to distinguish it from
    // literal code such as ```javascript inside an existing fenced block.
    if (this.pending.length >= 256 && !(this.fence && !this.lineStarted && /^ {0,3}(`{3,}|~{3,})/.test(this.pending))) {
      this.line(this.pending, false);
      this.pending = '';
    }
  }
  thinking(delta: string): void { this.output(delta); this.reasoning.push(delta); }
  tool(delta: string): void { this.output(delta); }
  private output(delta: string): void {
    this.characters += delta.length;
    if (this.characters > LOCAL_GENERATION_LIMITS.outputCharacters) throw new ThinkingLimitError('output');
  }
  private line(text: string, ended: boolean): void {
    let delimiter = false;
    if (!this.lineStarted) {
      const match = text.match(/^ {0,3}(`{3,}|~{3,})/);
      if (match && (!this.fence || (ended && match[1][0] === this.fence[0] && match[1].length >= this.fence.length && !text.slice(match[0].length).trim()))) {
        this.fence = this.fence ? '' : match[1];
        delimiter = true;
      }
    }
    if (!this.fence && !delimiter) this.prose.push(text + (ended ? '\n' : ''));
    this.lineStarted = !ended;
  }
}

/** Check a bounded tail, independent of how the server splits streaming chunks. */
export class ThinkingGuard {
  private tail = '';
  private characters = 0;
  private lastCheck = 0;
  constructor(private maxCharacters = 30_000) {}
  push(delta: string): void {
    this.characters += delta.length;
    this.tail = (this.tail + delta).slice(-12_000);
    if (this.characters > this.maxCharacters) throw new ThinkingLimitError('budget');
    if (this.characters < 1200 || this.characters - this.lastCheck < 256) return;
    this.lastCheck = this.characters;
    const words = this.tail.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const seen = new Map<string, number>();
    let maximum = 0;
    // Repeated headings/formulas amid new work are not a stalled thought.
    // Require a phrase repeated six times AND a heavily duplicated recent window.
    for (let index = 0; index <= words.length - 12; index++) {
      const phrase = words.slice(index, index + 12).join(' ');
      const count = (seen.get(phrase) ?? 0) + 1;
      maximum = Math.max(maximum, count);
      seen.set(phrase, count);
    }
    const windows = Math.max(1, words.length - 11);
    if (maximum >= 6 && 1 - seen.size / windows >= 0.65) throw new ThinkingLimitError('repetition');
  }
}
