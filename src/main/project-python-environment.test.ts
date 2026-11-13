import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { ProjectTools, projectTools } from './project-tools';
import { ProjectWorktreeService } from './project-worktrees';
import { ChatApprovals } from './chat-approvals';
import { pythonEnvironmentSchema, pythonInstallNeedsNetwork } from './project-python-environment';
import { commandSnapshot } from './project-command-state';
import { newHandoff, recordProjectAction } from './project-handoff';
import { hasCurrentProjectTest } from './project-delivery';
import { ChatService } from './chat';
import type { ChatThread } from '../shared/types';
import type { ProjectExecutionAdapter, ProjectExecutionRequest, ProjectExecutionResult } from './project-execution';
import { ProjectExecutionAdapter as NativeExecution } from './project-execution';
import type { ModelProvider } from './providers';
import type { ProjectAgentRuntime } from './project-agent-runtime';
import { ClaudeProjectRuntime } from './project-agent-runtime';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
// Full project workflows and tool definitions count toward the model window.
// These tests exercise environment approvals, not small-context rejection.
const profile = { provider: 'ollama' as const, connectionId: 'fixture', model: 'main', contextLimit: 32000 };

async function fixture(mode: 1 | 2 | 3 = 2) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-python-setup-'));
  const root = await fs.realpath(directory);
  const destination = path.join(root, '.venv_test');
  const python = path.join(destination, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const store = new Store(path.join(root, 'state.sqlite'));
  cleanup.push(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const project = { id: randomUUID(), path: root, name: 'Python fixture', permissionMode: mode, policyRevision: 1 };
  store.saveProject(project);
  store.saveSettings({
    connections: [{ id: 'fixture', provider: 'ollama', label: 'Fixture', url: 'http://127.0.0.1:11434' }],
    mainModel: profile,
    plannerModel: null,
    subagentModel: null,
  });
  const chat: ChatThread = {
    id: randomUUID(),
    projectId: project.id,
    title: 'Tests',
    profile,
    messages: [],
    status: 'idle',
    updatedAt: 1,
    projectHandoff: newHandoff(undefined, 'Prepare Python tests'),
  };
  chat.projectHandoff!.requirements = [
    { text: 'Run tests', status: 'not_run', verification: 'command', evidenceIds: [] },
  ];
  store.saveChat(chat);
  const approvals = new ChatApprovals(
    () => {},
    () => mode === 3,
  );
  const selected = {
    executable: process.execPath,
    version: [3, 11, 9],
    prefix: path.dirname(process.execPath),
    basePrefix: path.dirname(process.execPath),
    userSite: false,
  };
  let environmentVersion: number[] | undefined;
  let failPhase = '';
  const execute = vi.fn(async (request: ProjectExecutionRequest): Promise<ProjectExecutionResult> => {
    const phase = request.command.replace('Python environment: ', '');
    if (phase === failPhase) return { exitCode: 1, output: 'controlled failure', confined: true, timedOut: false };
    let output = '';
    if (phase === 'inspect interpreter') output = JSON.stringify(selected);
    if (phase === 'create environment') {
      await fs.mkdir(path.dirname(python), { recursive: true });
      await fs.writeFile(python, 'fixture launcher');
      await fs.writeFile(
        path.join(destination, 'pyvenv.cfg'),
        'include-system-site-packages = false\nversion = 3.11.9\n',
      );
    }
    if (phase === 'validate environment')
      output = JSON.stringify({
        ...selected,
        executable: python,
        prefix: destination,
        version: environmentVersion ?? selected.version,
      });
    if (phase === 'verify packages') output = JSON.stringify({ packages: { pytest: '9.2.0' }, imports: ['pytest'] });
    return { exitCode: 0, output, confined: true, timedOut: false };
  });
  const execution = {
    probe: async () => ({ available: true, version: '1.0.1' }),
    execute,
  } as unknown as ProjectExecutionAdapter;
  const tools = new ProjectTools(
    store,
    approvals,
    new ProjectWorktreeService(path.join(root, 'workspaces')),
    undefined,
    { execution },
  );
  const controller = new AbortController();
  await tools.prepare(chat, controller.signal);
  const input = {
    interpreter: process.execPath,
    environmentPath: '.venv_test',
    expectedVersion: '3.11',
    packages: ['pytest>=8,<10'],
    imports: ['pytest'],
  };
  return {
    root,
    destination,
    python,
    store,
    project,
    chat,
    tools,
    approvals,
    controller,
    execute,
    selected,
    input,
    fail: (phase: string) => {
      failPhase = phase;
    },
    mismatch: () => {
      environmentVersion = [3, 12, 10];
    },
  };
}

async function begin(f: Awaited<ReturnType<typeof fixture>>) {
  const pending = f.tools.execute(f.chat, 'setup_project_python_environment', f.input, f.controller.signal).then(
    (value) => ({ value: value as any, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await expect.poll(() => f.approvals.snapshot().length).toBe(1);
  return { pending, approval: f.approvals.snapshot()[0] };
}

it.each([1, 2, 3] as const)(
  'applies mode %i approvals to interpreter, venv, exact packages and real network access',
  async (mode) => {
    const f = await fixture(mode);
    let outcome: { value: any; error: any };
    if (mode === 3) {
      outcome = { value: await f.tools.execute(f.chat, 'setup_project_python_environment', f.input, f.controller.signal), error: undefined };
    } else {
      const { pending, approval } = await begin(f);
      expect(f.execute).not.toHaveBeenCalled();
      expect(approval.details).toContain(f.destination.replaceAll('\\', '\\\\'));
      expect(approval.details).toContain('pytest>=8,<10');
      expect(approval.details).toContain('network');
      f.approvals.answer(approval.id, true);
      outcome = await pending;
    }
    const { value, error } = outcome;
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ ready: true, interpreter: f.python, version: '3.11.9', projectChanged: true });
    expect(value.nextAction.arguments).toMatchObject({ executable: f.python, args: ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-v'], purpose: 'test' });
    expect(f.approvals.snapshot()).toEqual([]);
    expect(f.execute.mock.calls.map(([request]) => request.command)).toEqual([
      'Python environment: inspect interpreter',
      'Python environment: create environment',
      'Python environment: validate environment',
      'Python environment: install',
      'Python environment: check dependencies',
      'Python environment: verify packages',
    ]);
    for (const [request] of f.execute.mock.calls) {
      expect(request.writableRoots).toEqual([f.destination]);
      expect(request.network).toBe(request.command.endsWith(': install') ? 'allow' : 'deny');
      expect(request.environment).toEqual({ PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null' });
    }
    const install = f.execute.mock.calls.find(([request]) => request.command.endsWith(': install'))![0];
    expect(install.executable).toBe(f.python);
    expect(install.args).toEqual(
      expect.arrayContaining([
        '--isolated',
        '--require-virtualenv',
        '--no-cache-dir',
        '--index-url',
        'https://pypi.org/simple',
        'pytest>=8,<10',
      ]),
    );
    expect(f.tools.generation(f.chat)).toBe(1);
    expect(
      hasCurrentProjectTest(f.chat.projectHandoff!, [
        {
          id: 'setup',
          at: Date.now(),
          tool: 'setup_project_python_environment',
          label: 'Setup',
          input: JSON.stringify(f.input),
          result: JSON.stringify(value),
        },
      ]),
    ).toBe(false);
  },
);

it('returns a terminal actionable blocker and starts no subprocess after denial', async () => {
  const f = await fixture(2);
  const { pending, approval } = await begin(f);
  f.approvals.answer(approval.id, false);
  const { error } = await pending;
  expect(error).toMatchObject({
    code: 'ENVIRONMENT_APPROVAL_DENIED',
    details: { stopProjectRun: true, approvalRequired: true },
  });
  expect(error.details.nextAction).toContain('Wait for a new user message');
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.tools.generation(f.chat)).toBe(0);
});

it('does not launch or continue automatically after approval timeout or Stop', async () => {
  const f = await fixture();
  const { pending } = await begin(f);
  vi.useFakeTimers();
  // The production timer was created before fake timers. Trigger timeout through
  // a second fresh request with fake timers, cancelling the first via Stop.
  f.controller.abort(new Error('Stopped setup'));
  expect((await pending).error.message).toContain('Stopped setup');
  f.approvals.beginTurn(f.chat.id);
  const controller = new AbortController();
  const request = f.tools
    .execute(f.chat, 'setup_project_python_environment', f.input, controller.signal)
    .catch((error) => error);
  for (let index = 0; index < 100 && !f.approvals.snapshot().length; index++)
    await vi.waitFor(() => expect(f.approvals.snapshot()).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(300001);
  expect(await request).toMatchObject({ code: 'ENVIRONMENT_APPROVAL_TIMED_OUT', details: { stopProjectRun: true } });
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(['--user', 'https://example.com/a.whl', '../wheel', 'pytest --index-url evil', '-e .'])(
  'rejects unreviewable package specifications: %s',
  (spec) => {
    expect(() => pythonEnvironmentSchema.parse({ interpreter: process.execPath, packages: [spec] })).toThrow();
  },
);

it('keeps the tool strict and Main-only; pip without network gets a setup action before approval', async () => {
  const f = await fixture();
  expect(projectTools.some((tool) => tool.function.name === 'setup_project_python_environment')).toBe(true);
  expect(f.tools.toolsForWorker(false).some((tool) => tool.function.name === 'setup_project_python_environment')).toBe(
    false,
  );
  expect(() => pythonEnvironmentSchema.parse({ ...f.input, packages: '["pytest"]' })).toThrow();
  expect(() => pythonEnvironmentSchema.parse({ ...f.input, pipArgs: ['--user'] })).toThrow();
  await expect(
    f.tools.execute(
      f.chat,
      'run_project_process',
      { executable: process.execPath, args: ['-m', 'pip', 'install', 'pytest'] },
      f.controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'ENVIRONMENT_SETUP_REQUIRED' });
  expect(f.approvals.snapshot()).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
  expect(pythonInstallNeedsNetwork({ command: 'python -m pip install --no-index pytest' })).toBe(false);
});

it('accepts the setup schema through the actual model SDK and delivers the reviewed tool result', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = { chat: async (input: any) => {
    if (++calls === 1) {
      expect(input.tools.some((tool: any) => tool.function.name === 'mcp__mercury__setup_project_python_environment')).toBe(true);
      const { environmentPath: _defaultPath, ...args } = f.input;
      return { text: '', tools: [{ id: 'setup-once', name: 'mcp__mercury__setup_project_python_environment', arguments: args }] };
    }
    const results = input.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content);
    expect(JSON.stringify(results)).toContain('Environment setup only');
    const text = 'Environment prepared; project tests still need to run.';
    input.onText?.(text);
    return { text, tools: [] };
  } } as unknown as ModelProvider;
  const runtime = new ClaudeProjectRuntime(provider, path.join(f.root, 'sdk-sessions'), {
    executablePath: path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
  });
  cleanup.push(() => runtime.shutdown());
  const run = runtime.run({ projectId: f.project.id, chatId: f.chat.id, workspaceRoot: f.root, profile,
    messages: [{ role: 'user', content: 'Prepare the Python environment using the offered setup tool, then report its result.' }],
    tools: projectTools, signal: f.controller.signal,
    execute: (name, args) => f.tools.execute(f.chat, name, args, f.controller.signal) });
  await expect.poll(() => f.approvals.snapshot().length, { timeout: 15000 }).toBe(1);
  expect(f.execute).not.toHaveBeenCalled();
  f.approvals.answer(f.approvals.snapshot()[0].id, true);
  expect((await run).text).toContain('project tests still need to run');
  expect(calls).toBe(2);
}, 60000);

it('refuses an existing non-venv directory and a linked destination without changing it', async () => {
  const f = await fixture();
  await fs.mkdir(f.destination);
  await fs.writeFile(path.join(f.destination, 'keep.txt'), 'keep');
  await expect(
    f.tools.execute(f.chat, 'setup_project_python_environment', f.input, f.controller.signal),
  ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_VENV' });
  expect(await fs.readFile(path.join(f.destination, 'keep.txt'), 'utf8')).toBe('keep');
  const link = path.join(f.root, '.venv_link');
  await fs.symlink(f.destination, link, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(
    f.tools.execute(
      f.chat,
      'setup_project_python_environment',
      { ...f.input, environmentPath: '.venv_link' },
      f.controller.signal,
    ),
  ).rejects.toMatchObject({ code: 'ENVIRONMENT_PATH_CHANGED' });
  expect(f.execute).not.toHaveBeenCalled();
});

it('rechecks the selected environment and policy after approval, before executing', async () => {
  const f = await fixture();
  const { pending, approval } = await begin(f);
  await fs.mkdir(f.destination);
  await fs.writeFile(path.join(f.destination, 'keep'), 'not a venv');
  f.approvals.answer(approval.id, true);
  expect((await pending).error.code).toBe('ENVIRONMENT_NOT_VENV');
  expect(f.execute).not.toHaveBeenCalled();
});

it('rejects permission changes and destination redirection while approval is pending', async () => {
  const f = await fixture();
  let review = await begin(f);
  f.store.saveProject({ ...f.project, permissionMode: 1, policyRevision: 2 });
  f.approvals.answer(review.approval.id, true);
  expect((await review.pending).error.message).toContain('permissions changed');
  f.store.saveProject(f.project);
  review = await begin(f);
  const other = path.join(f.root, 'other');
  await fs.mkdir(other);
  await fs.symlink(other, f.destination, process.platform === 'win32' ? 'junction' : 'dir');
  f.approvals.answer(review.approval.id, true);
  expect((await review.pending).error.code).toBe('ENVIRONMENT_PATH_CHANGED');
  expect(f.execute).not.toHaveBeenCalled();
});

it('rejects an existing venv with a different Python before installing packages', async () => {
  const f = await fixture();
  const first = await begin(f);
  f.approvals.answer(first.approval.id, true);
  expect((await first.pending).error).toBeUndefined();
  f.execute.mockClear();
  f.mismatch();
  const second = await begin(f);
  f.approvals.answer(second.approval.id, true);
  expect((await second.pending).error).toMatchObject({ code: 'ENVIRONMENT_VERSION_MISMATCH', details: { selected: { version: [3, 11, 9] }, environment: { version: [3, 12, 10] }, failedChecks: ['version'] } });
  expect(f.execute.mock.calls.map(([request]) => request.command)).toEqual([
    'Python environment: inspect interpreter',
    'Python environment: validate environment',
  ]);
});

it('rejects project-range mismatches before any installation and identifies every version', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, 'requirements.txt'), '# Python 3.11-3.12 required\nrequests');
  f.selected.version = [3, 13, 15];
  const { pending, approval } = await begin(f);
  f.approvals.answer(approval.id, true);
  const { error } = await pending;
  expect(error).toMatchObject({ code: 'PYTHON_VERSION_MISMATCH', details: { selected: { version: [3, 13, 15] }, failedChecks: ['version'], projectChanged: false, stopProjectRun: true } });
  expect(error.details.required).toContainEqual({ source: 'requirements.txt', line: 1, specifier: '>=3.11,<3.13' });
  expect(f.execute.mock.calls.map(([request]) => request.command)).toEqual(['Python environment: inspect interpreter']);
});

it('preserves a partially created environment and invalidates verification when Stop interrupts setup', async () => {
  const f = await fixture();
  const original = f.execute.getMockImplementation()!;
  f.execute.mockImplementation(async (request) => {
    const result = await original(request);
    if (request.command.endsWith(': create environment')) f.controller.abort(new Error('Stopped during creation'));
    return result;
  });
  const { pending, approval } = await begin(f);
  f.approvals.answer(approval.id, true);
  expect((await pending).error.message).toContain('Stopped during creation');
  expect(await fs.readFile(path.join(f.destination, 'pyvenv.cfg'), 'utf8')).toContain('false');
  expect(f.tools.generation(f.chat)).toBe(1);
  expect(f.execute).toHaveBeenCalledTimes(2);
});

it.runIf(Boolean(process.env.MERCURY_LIVE_PYTHON))(
  'smoke: creates and validates a real disposable Python environment without downloads',
  async () => {
    const f = await fixture(3);
    f.input.interpreter = process.env.MERCURY_LIVE_PYTHON!;
    f.input.packages = [];
    f.input.imports = ['json'];
    await fs.writeFile(path.join(f.root, 'test_environment.py'), `import json,sys,unittest
class EnvironmentSmoke(unittest.TestCase):
 def test_isolated_python(self):
  self.assertNotEqual(sys.prefix,sys.base_prefix)
  self.assertTrue(json.loads('{"ok":true}')["ok"])
`);
    const execution = new NativeExecution(path.join(f.root, 'unused-runtime'), path.join(f.root, 'scratch'));
    f.execute.mockImplementation((request) => execution.execute(request, f.controller.signal));
    try {
      const value: any = await f.tools.execute(f.chat, 'setup_project_python_environment', f.input, f.controller.signal);
      expect(f.approvals.snapshot()).toEqual([]);
      expect(value).toMatchObject({ ready: true, interpreter: f.python, packages: {}, imports: ['json'] });
      expect(f.execute.mock.calls.every(([request]) => request.network === 'deny')).toBe(true);
      const verify = await execution.execute(
        {
          command: 'Smoke assertions',
          executable: f.python,
          args: value.nextAction.arguments.args,
          mode: 3,
          workspaceRoot: f.root,
          cwd: f.root,
        },
        f.controller.signal,
      );
      expect(verify).toMatchObject({ exitCode: 0, timedOut: false });
      expect(verify.output).toContain('test_isolated_python');
      expect(verify.output).toContain('Ran 1 test');
      expect(verify.output).toContain('OK');
    } finally {
      await execution.shutdown();
    }
  },
  120000,
);

it('rejects a Python version mismatch before creation and preserves partial files on installation failure', async () => {
  const f = await fixture();
  f.selected.version = [3, 13, 1];
  let review = await begin(f);
  f.approvals.answer(review.approval.id, true);
  expect((await review.pending).error.code).toBe('PYTHON_VERSION_MISMATCH');
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.tools.generation(f.chat)).toBe(0);
  f.selected.version = [3, 11, 9];
  f.execute.mockClear();
  f.fail('install');
  review = await begin(f);
  f.approvals.answer(review.approval.id, true);
  const { error } = await review.pending;
  expect(error).toMatchObject({
    code: 'ENVIRONMENT_SETUP_FAILED',
    details: { phase: 'install', projectChanged: true },
  });
  expect(await fs.readFile(path.join(f.destination, 'pyvenv.cfg'), 'utf8')).toContain('3.11');
  expect(f.tools.generation(f.chat)).toBe(1);
  expect(f.execute).toHaveBeenCalledTimes(4);
});

it('invalidates prior verification without recording setup as a passed project test', () => {
  const handoff = newHandoff(undefined, 'Prepare tests');
  handoff.requirements = [{ text: 'Tests pass', verification: 'command', status: 'passed', evidenceIds: ['old'] }];
  recordProjectAction(
    handoff,
    'setup_project_python_environment',
    { environmentPath: '.venv_test' },
    { ready: true, projectChanged: true },
    'setup',
  );
  expect(handoff.requirements[0].status).toBe('not_run');
  expect(handoff.checks).toEqual([]);
  expect(handoff.generation).toBe(1);
});

it('keeps Python environments and caches out of source snapshots', async () => {
  const f = await fixture();
  const before = await commandSnapshot(f.root);
  for (const dir of ['.venv', '.venv_test', '__pycache__', '.pytest_cache']) {
    await fs.mkdir(path.join(f.root, dir), { recursive: true });
    await fs.writeFile(path.join(f.root, dir, 'generated'), 'runtime or cache');
  }
  expect(await commandSnapshot(f.root)).toEqual(before);
});

it.each(['denial', 'install timeout'])(
  'ends the model turn after %s instead of invoking completion repair or alternate commands',
  async (reason) => {
    const f = await fixture();
    if (reason === 'install timeout') {
      const original = f.execute.getMockImplementation()!;
      f.execute.mockImplementation((request) =>
        request.command.endsWith(': install')
          ? Promise.resolve({ exitCode: null, output: 'Installation timed out', timedOut: true, confined: true })
          : original(request),
      );
    }
    let runs = 0;
    const { environmentPath: _defaultPath, ...inputWithoutDefaults } = f.input;
    const runtime = {
      run: async (input) => {
        runs++;
        await input.execute('setup_project_python_environment', inputWithoutDefaults);
        await input.execute('run_project_command', { command: 'alternative installer' });
        return { text: 'This must never be reached.' };
      },
    } as ProjectAgentRuntime;
    const service = new ChatService(
      f.store,
      {} as ModelProvider,
      () => {},
      () => false,
      undefined,
      undefined,
      f.tools,
      runtime,
    );
    const pending = service.send(f.chat.id, profile, 'Prepare and test the project');
    await expect.poll(() => f.approvals.snapshot().length).toBe(1);
    f.approvals.answer(f.approvals.snapshot()[0].id, reason !== 'denial');
    await pending;
    const saved = f.store.chat(f.chat.id);
    expect(runs).toBe(1);
    expect(f.execute).toHaveBeenCalledTimes(reason === 'denial' ? 0 : 4);
    expect(saved.status).toBe('stopped');
    expect(saved.projectHandoff?.blocker).toMatchObject({
      code: reason === 'denial' ? 'ENVIRONMENT_APPROVAL_DENIED' : 'ENVIRONMENT_SETUP_FAILED',
      target: '.venv_test',
      nextAction: expect.stringContaining(
        reason === 'denial' ? 'Wait for a new user message' : 'Ask the user to review',
      ),
    });
    expect(saved.messages.at(-1)?.toolActivity).toHaveLength(1);
    expect(saved.messages.at(-1)?.content).toContain(
      reason === 'denial' ? 'No setup command ran' : 'Installation timed out',
    );
  },
);
