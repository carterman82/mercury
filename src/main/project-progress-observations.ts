import type { ProjectProgressObservation } from '../shared/types';
import { toolFailed } from './tool-outcome';

const metadata = new Set(['revision', 'evidenceId', 'at', 'observedAt', 'updatedAt', 'durationMs', 'readReuse', 'originEvidenceId', 'recovery']);
const clean = (value: any): any => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => !metadata.has(key)).sort().map(key => [key, clean(value[key])])) : value;

/** Host observations, never model narration, establish forward progress. */
export class ProjectProgressObservations {
  private files = new Map<string, { hash: string; ranges: [number, number][] }>();
  private evidence = new Set<string>();
  private checks = new Set<string>();
  private diagnosisAccepted = false;
  private contractInitialized = false;
  observe(name: string, args: any, result: any): ProjectProgressObservation | undefined {
    if (toolFailed(result)) return;
    if (result?.projectChanged === true || (['patch_project_file', 'patch_project_record', 'edit_project_file', 'download_project_asset'].includes(name) && result?.hash && result.hash !== result.previousHash)) {
      this.checks.clear();
      return { kind: 'mutation', detail: String(result.path ?? args?.path ?? name) };
    }
    if (name === 'record_project_diagnosis') {
      const accepted = result?.executionConfirmed === true;
      const changed = accepted && !this.diagnosisAccepted;
      this.diagnosisAccepted = accepted;
      return changed ? { kind: 'diagnosis', detail: 'Diagnosis accepted; narrow edits are authorized.' } : undefined;
    }
    if (name === 'update_project_task') {
      // update_project_task always establishes progress when called successfully,
      // as it initializes or updates the task contract regardless of requirement status
      const failed = toolFailed(result);
      if (!failed) {
        this.contractInitialized = true;
        const detail = result?.requirements ? (Array.isArray(result.requirements) ? `Acceptance criteria updated (${result.requirements.length} requirements).` : 'Task contract initialized.') : 'Task contract initialized with empty requirements.';
        return { kind: 'contract', detail };
      }
      return;
    }
    if (name === 'read_project_file' && typeof result?.hash === 'string') {
      // Check if this is a cached read (reused from cache without new validation)
      const readReuse = result.readReuse;
      if (readReuse?.kind === 'validated-cache') {
        // Cached reads don't establish fresh progress
        return;
      }
      let target = String(result.sourcePath ?? args?.path ?? '').replaceAll('\\', '/');
      if (process.platform === 'win32') target = target.toLowerCase();
      let file = this.files.get(target);
      const newFile = !file || file.hash !== result.hash;
      if (!file || file.hash !== result.hash) {
        file = { hash: result.hash, ranges: [] }; this.files.set(target, file); this.checks.clear();
      }
      if (!Number.isInteger(result.startLine) || !Number.isInteger(result.endLine))
        return newFile ? { kind: 'source', detail: `${target}: source hash observed; coverage unspecified` } : undefined;
      const range: [number, number] = [result.startLine, result.endLine];
      if (range[1] < range[0]) return newFile ? { kind: 'source', detail: `${target}: empty file observed` } : undefined;
      if (file.ranges.some(([start, end]) => start <= range[0] && end >= range[1])) return;
      const ranges = [...file.ranges, range].sort((a, b) => a[0] - b[0]);
      file.ranges = [];
      for (const current of ranges) {
        const previous = file.ranges.at(-1);
        if (previous && previous[1] + 1 >= current[0]) previous[1] = Math.max(previous[1], current[1]);
        else file.ranges.push([...current]);
      }
      return { kind: 'source', detail: `${target}:${range[0]}-${range[1]}` };
    }
    if (['run_project_command', 'run_project_process'].includes(name) && result?.exitCode === 0 && !result.verificationUnknown) {
      const key = JSON.stringify([name, clean(args)]);
      if (this.checks.has(key)) return;
      this.checks.add(key);
      return { kind: args?.purpose === 'test' ? 'check' : 'evidence', detail: 'New successful execution observed.' };
    }
    if (/^(read_|list_|search_|query_|recall_|web_|browser_)/.test(name) && !['read_project_task', 'read_chat_history', 'recall_context'].includes(name)) {
      const key = JSON.stringify([name, clean(result)]);
      if (this.evidence.has(key)) return;
      this.evidence.add(key);
      if (this.evidence.size > 512) this.evidence.delete(this.evidence.values().next().value!);
      return { kind: 'evidence', detail: name };
    }
  }
}
