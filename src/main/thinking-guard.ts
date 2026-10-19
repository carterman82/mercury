export type ThinkingFailure = 'repetition' | 'budget' | 'timeout';
export class ThinkingLimitError extends Error {
  constructor(readonly kind: ThinkingFailure) { super(`Thinking ${kind} limit reached.`); }
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
    // Six repetitions of a twelve-word phrase strongly suggest a stalled thought.
    for (let index = 0; index <= words.length - 12; index++) {
      const phrase = words.slice(index, index + 12).join(' ');
      const count = (seen.get(phrase) ?? 0) + 1;
      if (count >= 6) throw new ThinkingLimitError('repetition');
      seen.set(phrase, count);
    }
  }
}
