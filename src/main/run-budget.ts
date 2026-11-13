import { createHash } from 'node:crypto';
import { toolFailed } from './tool-outcome';

export const FINAL_GENERATION_INSTRUCTION =
  'Summarize completed work and remaining limitations using existing evidence; perform no further actions. The response generation allowance is exhausted. Do not claim unfinished work is complete.';
export class RunLimitError extends Error {}
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'null')
    .digest('hex');
type Observation = { name: string; args: any; key: string; result: string; failed: boolean; hash?: string };

/** One owner per user response/worker assignment; continuations never replenish it. */
export class RunBudget {
  private generations = 0;
  private actions = 0;
  private recovered = false;
  private revision?: number;
  private history: Observation[] = [];
  get recoveries(): number {
    return this.recovered ? 1 : 0;
  }
  constructor(private limits: { generations?: number; actions?: number } = {}) {}
  get summaryOnly(): boolean {
    return this.generations >= (this.limits.generations ?? 128);
  }
  generation(): boolean {
    if (++this.generations > (this.limits.generations ?? 128))
      throw new RunLimitError(
        'Response generation limit reached. Partial work is saved; send a follow-up to continue.',
      );
    return this.summaryOnly;
  }
  claimRecovery(reason = 'The model stalled again'): void {
    if (this.recovered)
      throw new RunLimitError(
        `${reason} after one recovery attempt. Partial work is saved; send a follow-up to continue.`,
      );
    this.recovered = true;
  }
  private reconcile(revision: number): void {
    if (revision !== this.revision) {
      this.history = [];
      this.revision = revision;
    }
  }
  async beforeTool(
    name: string,
    args: unknown,
    revision: number,
    readCurrent?: (args: any, hash: string) => Promise<boolean>,
  ): Promise<string | undefined> {
    if (this.summaryOnly)
      throw new RunLimitError('The final generation may only summarize saved work; tool actions are disabled.');
    if (++this.actions > (this.limits.actions ?? 256))
      throw new RunLimitError(
        'Tool action safety limit reached (256 actions). Partial work is saved; send a follow-up to continue.',
      );
    this.reconcile(revision);
    // Active process status polls have their own bounded waiting/cancellation rules.
    if (['project_server_status', 'project_process_status'].includes(name)) return;
    const key = digest([name, args]);
    const matching = this.history.slice(-12).filter((item) => item.key === key);
    let repeated =
      matching.length >= 2 &&
      matching.at(-1)!.result === matching.at(-2)!.result &&
      matching.at(-1)!.failed;
    if (repeated && name === 'read_project_file') {
      const latest = matching.at(-1)!;
      // Check if this is a cached read (reused with readReuse metadata)
      const isCachedRead = latest.result && typeof latest.result === 'object' && (latest.result as any)?.readReuse?.kind === 'validated-cache';
      if (isCachedRead) {
        // Cached reads don't trigger recovery - they reuse existing evidence
        this.history = this.history.filter((item) => item.key !== key);
        repeated = false;
      } else if (!latest.hash || !readCurrent || !(await readCurrent(latest.args, latest.hash))) {
        this.history = this.history.filter((item) => item.key !== key);
        repeated = false;
      }
    }
    for (let length = 1; !repeated && length <= 5 && this.history.length >= length * 2; length++) {
      const a = this.history.slice(-length * 2, -length),
        b = this.history.slice(-length);
      if (b[0].key !== key || !a.every((item, index) => item.key === b[index].key && item.result === b[index].result))
        continue;
      if (b.some(item => item.name === 'read_project_file' && !item.failed)) continue;
      // Revalidate every file read in a candidate cycle, including external edits.
      let current = true;
      for (const item of b.filter((item) => item.name === 'read_project_file')) {
        // Check if this is a cached read
        const isCachedRead = item.result && typeof item.result === 'object' && (item.result as any)?.readReuse?.kind === 'validated-cache';
        // Cached reads don't need external validation for recovery purposes
        if (!isCachedRead && (!item.hash || !readCurrent || !(await readCurrent(item.args, item.hash)))) {
          current = false;
          break;
        }
      }
      if (current) repeated = true;
      else this.history = [];
    }
    if (!repeated) return;
    this.claimRecovery(`Repeated unchanged ${name} action`);
    return 'MERCURY RECOVERY: Repeated unchanged work was blocked before execution. Use saved results and a different approach, or report the blocker. Never replay completed mutations. Only one recovery attempt is allowed.';
  }
  observe(name: string, args: unknown, result: any, revision: number): void {
    this.reconcile(revision);
    if (['project_server_status', 'project_process_status'].includes(name)) return;
    const clean =
      result && typeof result === 'object' && !Array.isArray(result)
        ? Object.fromEntries(
            Object.entries(result).filter(
              ([key]) =>
                !['evidenceId', 'revision', 'at', 'observedAt', 'updatedAt', 'durationMs', 'recovery', 'readReuse'].includes(key),
            ),
          )
        : result;
    this.history.push({
      name,
      args,
      key: digest([name, args]),
      result: digest(clean),
      failed: toolFailed(result),
      hash: result?.hash,
    });
    this.history = this.history.slice(-32);
  }
}
