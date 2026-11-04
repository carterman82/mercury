import { expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProjectRuntime } from './project-agent-runtime';
import { ProjectTools, projectTools } from './project-tools';
import { ChatApprovals } from './chat-approvals';
import { failedToolResult } from './tool-outcome';
import type { ChatThread } from '../shared/types';
import type { Store } from './store';
import type { ProjectWorktreeService } from './project-worktrees';
import type { ModelProvider } from './providers';

const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'fixture', contextLimit: 16000 };
type Read = { hash: string; revision: string };
const cases = [
  ...[undefined, ''].flatMap(revision => [undefined, 'null', ''].flatMap(expectedHash => [
    { label: `empty create preconditions create a missing file (${String(revision)},${String(expectedHash)})`, tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'new.txt', content: 'new', revision, expectedHash }), file: 'new.txt', content: 'new' },
    { label: `empty create preconditions cannot overwrite (${String(revision)},${String(expectedHash)})`, tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'note.txt', content: 'new', revision, expectedHash }), file: 'note.txt', content: 'old', code: 'CREATE_TARGET_EXISTS' },
  ])),
  { label: 'blank revision does not override a real hash', tool: 'edit_project_file', raw: (read: Read) => ({ path: 'note.txt', content: 'new', revision: '', expectedHash: read.hash }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'blank hash does not override a real revision', tool: 'edit_project_file', raw: (read: Read) => ({ path: 'note.txt', content: 'new', revision: read.revision, expectedHash: '' }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'explicit null does not repair a blank revision', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'note.txt', content: 'new', revision: '', expectedHash: null }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'whitespace revision stays invalid', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'note.txt', content: 'new', revision: ' ', expectedHash: '' }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'whitespace hash stays invalid', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'note.txt', content: 'new', revision: '', expectedHash: ' ' }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'blank patch preconditions stay invalid', tool: 'patch_project_file', raw: (_read: Read) => ({ path: 'note.txt', oldText: 'old', newText: 'new', revision: '', expectedHash: '' }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'quoted null creates a missing file', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'new.txt', content: 'new', expectedHash: 'null' }), file: 'new.txt', content: 'new' },
  { label: 'omitted null creates a missing file', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'new.txt', content: 'new' }), file: 'new.txt', content: 'new' },
  { label: 'hash in revision repairs an edit', tool: 'edit_project_file', raw: (read: Read) => ({ path: 'note.txt', content: 'new', revision: read.hash }), file: 'note.txt', content: 'new' },
  { label: 'UUID in hash repairs a patch', tool: 'patch_project_file', raw: (read: Read) => ({ path: 'note.txt', oldText: 'old', newText: 'new', expectedHash: read.revision }), file: 'note.txt', content: 'new' },
  { label: 'hash in revision repairs a patch', tool: 'patch_project_file', raw: (read: Read) => ({ path: 'note.txt', oldText: 'old', newText: 'new', revision: read.hash }), file: 'note.txt', content: 'new' },
  { label: 'quoted null cannot overwrite an existing file', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'note.txt', content: 'new', expectedHash: 'null' }), file: 'note.txt', content: 'old', code: 'CREATE_TARGET_EXISTS' },
  { label: 'conflicting hash fields stay invalid', tool: 'edit_project_file', raw: (read: Read) => ({ path: 'note.txt', content: 'new', revision: read.hash, expectedHash: read.hash }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'valid revision retains precedence over a conflicting hash', tool: 'edit_project_file', raw: (read: Read) => ({ path: 'note.txt', content: 'new', revision: read.revision, expectedHash: '0'.repeat(64) }), file: 'note.txt', content: 'new' },
  { label: 'unknown revision rejects even with a valid hash', tool: 'edit_project_file', raw: (read: Read) => ({ path: 'note.txt', content: 'new', revision: '11111111-1111-4111-8111-111111111111', expectedHash: read.hash }), file: 'note.txt', content: 'old', code: 'UNKNOWN_REVISION' },
  { label: 'patch null is not repaired', tool: 'patch_project_file', raw: (_read: Read) => ({ path: 'note.txt', oldText: 'old', newText: 'new', expectedHash: 'null' }), file: 'note.txt', content: 'old', code: 'INVALID_ARGUMENTS' },
  { label: 'unknown UUID remains unauthorized', tool: 'edit_project_file', raw: (_read: Read) => ({ path: 'note.txt', content: 'new', expectedHash: '11111111-1111-4111-8111-111111111111' }), file: 'note.txt', content: 'old', code: 'UNKNOWN_REVISION' },
];

it.each(cases)('keeps SDK ingress and direct project execution equivalent: $label', async scenario => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-normalization-entrypoints-'));
  const provider = { chat: vi.fn(async () => { throw new Error('No model calls are allowed.'); }) } as unknown as ModelProvider;
  let runtime: ClaudeProjectRuntime | undefined;
  try {
    const outcomes: unknown[] = [];
    for (const lane of ['direct', 'sdk']) {
      const lanePath = path.join(directory, lane);
      await fs.mkdir(lanePath);
      const root = await fs.realpath(lanePath);
      await fs.writeFile(path.join(root, 'note.txt'), 'old');
      const chat: ChatThread = { id: randomUUID(), projectId: randomUUID(), title: 'Fixture', profile, status: 'idle', messages: [], updatedAt: 1 };
      const store = { project: () => ({ id: chat.projectId, path: root, permissionMode: 2, policyRevision: 1 }) } as unknown as Store;
      const projects = new ProjectTools(store, new ChatApprovals(() => {}), { storageRoot: path.join(directory, 'storage') } as ProjectWorktreeService);
      // Keep real execution, schemas, revision ownership and filesystem edits;
      // bypass only worktree initialization, which is unrelated to ingress.
      vi.spyOn(projects, 'getWorkspace').mockReturnValue({ id: chat.id, root } as ReturnType<ProjectTools['getWorkspace']>);
      const signal = new AbortController().signal;
      const read = await projects.execute(chat, 'read_project_file', { path: 'note.txt' }, signal) as Read;
      const raw = scenario.raw(read);
      const dispatch = async (name: string, args: unknown) => {
        try { return await projects.execute(chat, name, args, signal); }
        catch (error) { return failedToolResult(error); }
      };
      let output: any;
      if (lane === 'direct') output = await dispatch(scenario.tool, raw);
      else {
        let handler!: (request: unknown, extra: unknown) => Promise<any>;
        const executed = vi.fn(dispatch);
        const rejected = vi.fn(async (_name, _args, attempt) => failedToolResult(attempt.validationError));
        const closed = vi.fn();
        const sdk = {
          tool: vi.fn((name: string) => ({ name })),
          createSdkMcpServer: () => ({ instance: { server: { setRequestHandler: (_schema: unknown, callback: typeof handler) => { handler = callback; } } } }),
          query: () => Object.assign((async function* () {
            const result = await handler({ params: { name: scenario.tool, arguments: raw } }, { requestId: 'fixture-attempt' });
            output = JSON.parse(result.content[0].text);
            yield { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Checked fixture.' }] } };
            yield { type: 'result', subtype: 'success', is_error: false, session_id: 'fixture-session' };
          })(), { close: closed }),
        };
        runtime = new ClaudeProjectRuntime(provider, path.join(directory, 'sessions'), { loadSdk: async () => sdk as any });
        await runtime.run({ projectId: chat.projectId!, chatId: chat.id, workspaceRoot: root, profile,
          messages: [{ role: 'user', content: 'Check the fixture.' }], tools: projectTools.filter(tool => tool.function.name === scenario.tool),
          execute: executed, onToolValidationFailure: rejected, signal });
        expect(closed).toHaveBeenCalledOnce();
        expect(rejected).toHaveBeenCalledTimes(scenario.code === 'INVALID_ARGUMENTS' ? 1 : 0);
        expect(executed).toHaveBeenCalledTimes(scenario.code === 'INVALID_ARGUMENTS' ? 0 : 1);
        await runtime.shutdown();
      }
      expect(await fs.readFile(path.join(root, scenario.file), 'utf8')).toBe(scenario.content);
      if (scenario.code) {
        expect(output).toMatchObject({ isError: true, code: scenario.code });
        expect(projects.generation(chat)).toBe(0);
        outcomes.push({ code: output.code, isError: output.isError });
      } else {
        expect(output).toMatchObject({ path: scenario.file, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(projects.generation(chat)).toBe(1);
        outcomes.push({ path: output.path, hash: output.hash, previousHash: output.previousHash });
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(provider.chat).not.toHaveBeenCalled();
  } finally {
    await runtime?.shutdown();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
