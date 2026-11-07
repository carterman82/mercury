import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  ProjectExecutionAdapter,
  mxcHostEnvironment,
  type MxcProcessInput,
  type MxcProcessResult,
  type ProjectExecutionRequest,
} from './project-execution';

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
});
const result = (stdout = '', exitCode = 0): MxcProcessResult => ({ stdout, stderr: '', exitCode, timedOut: false });
const supported = () =>
  result(
    JSON.stringify({
      tier: 'base-container',
      needsDaclAugmentation: false,
      probes: { baseContainerApiPresent: true },
      warnings: [],
    }),
  );

async function fixture(
  transport = vi.fn(async (input: MxcProcessInput) =>
    input.args.includes('--probe') ? supported() : result('verified'),
  ),
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-execution-'));
  temporary.push(root);
  const runtime = path.join(root, 'runtime'),
    workspace = path.join(root, 'workspace'),
    scratch = path.join(root, 'scratch');
  await fs.mkdir(runtime);
  await fs.mkdir(workspace);
  const binary = Buffer.from('verified test executor fixture');
  await fs.writeFile(path.join(runtime, 'wxc-exec.exe'), binary);
  await fs.writeFile(
    path.join(runtime, 'runtime.json'),
    JSON.stringify({
      version: '1.0.1',
      contractVersion: '1.0.0',
      files: { 'wxc-exec.exe': createHash('sha256').update(binary).digest('hex') },
    }),
  );
  const adapter = new ProjectExecutionAdapter(runtime, scratch, {
    transport,
    platform: 'win32',
    deviceReadRoots: async () => [root],
  });
  const request: ProjectExecutionRequest = {
    command: 'echo verified',
    cwd: workspace,
    workspaceRoot: workspace,
    mode: 2,
  };
  return { root, runtime, workspace, scratch, adapter, request, transport };
}

it('executes structured arguments and multiline stdin without shell interpretation', async () => {
  const { adapter, request, workspace } = await fixture();
  const input = 'quotes " [data-view=] & | $ `\n你好';
  const executed = await adapter.execute(
    {
      ...request,
      mode: 3,
      executable: process.execPath,
      args: [
        '-e',
        'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>console.log(JSON.stringify({s,args:process.argv.slice(1)})))',
        'literal & | " $',
      ],
      stdin: input,
    },
    new AbortController().signal,
  );
  expect(executed.exitCode).toBe(0);
  expect(JSON.parse(executed.output)).toEqual({ s: input, args: ['literal & | " $'] });
  expect(workspace).toBeTruthy();
});

it('confines structured execution with a host-owned launcher instead of shell source', async () => {
  const { adapter, request, root } = await fixture();
  const scratch = path.join(root, 'launcher-work');
  await fs.mkdir(scratch);
  const policy: any = await adapter.policy(
    { ...request, executable: 'node', args: ['-'], stdin: 'console.log("[data-view=]")' },
    scratch,
  );
  expect(policy.process.commandLine).not.toContain('cmd.exe');
  const launcher = await fs.readFile(path.join(scratch, 'structured-process.cjs'), 'utf8');
  expect(launcher).toContain('shell:false');
  expect(launcher).toContain('data-view');
});

it.runIf(process.env.MERCURY_LIVE_MXC === '1')(
  'runs structured stdin in real Windows confinement',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-structured-live-'));
    temporary.push(root);
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const adapter = new ProjectExecutionAdapter(
      path.resolve('.build-resources/mxc-runtime'),
      path.join(root, 'scratch'),
    );
    const request: ProjectExecutionRequest = {
      command: 'structured stdin fixture',
      executable: process.execPath,
      args: ['-'],
      stdin:
        'require("fs").writeFileSync("written.txt","你好 [data-view=] & quotes");console.log("structured confined success")',
      cwd: workspace,
      workspaceRoot: workspace,
      mode: 1,
      win32k: true,
    };
    const result = await adapter.execute(request, new AbortController().signal);
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, confined: true });
    expect(await fs.readFile(path.join(workspace, 'written.txt'), 'utf8')).toBe('你好 [data-view=] & quotes');
  },
  45000,
);

it.runIf(process.env.MERCURY_LIVE_MXC === '1')(
  'provides writable temporary storage for shell and structured diagnostic commands',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-temp-live-'));
    temporary.push(root);
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const adapter = new ProjectExecutionAdapter(
      path.resolve('.build-resources/mxc-runtime'),
      path.join(root, 'scratch'),
    );
    const script =
      'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");const dir=fs.mkdtempSync(path.join(os.tmpdir(),"child-temp-"));fs.writeFileSync(path.join(dir,"file"),"ok");console.log("temporary storage works");try{fs.writeFileSync("forbidden.txt","no");process.exitCode=2}catch{console.log("project writes denied")}';
    // The script is read-only project data; the process may only write scratch.
    await fs.writeFile(path.join(workspace, 'temp-check.cjs'), script);
    for (const structured of [false, true]) {
      const result = await adapter.execute(
        {
          command: structured ? 'temporary storage check' : `"${process.execPath}" temp-check.cjs`,
          ...(structured ? { executable: process.execPath, args: ['-'], stdin: script } : {}),
          cwd: workspace,
          workspaceRoot: workspace,
          mode: 2,
          writableRoots: [],
          win32k: true,
        },
        new AbortController().signal,
      );
      expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, confined: true });
      expect(result.output).toContain('temporary storage works');
      expect(result.output).toContain('project writes denied');
      await expect(fs.stat(path.join(workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const shellTemp = await adapter.execute(
      {
        command:
          'echo temporary > "%TEMP%\\shell-child.txt" && type "%TEMP%\\shell-child.txt" & for %i in (1) do @echo value-%i & echo "a&b"',
        cwd: workspace,
        workspaceRoot: workspace,
        mode: 2,
        writableRoots: [],
      },
      new AbortController().signal,
    );
    expect(shellTemp, JSON.stringify(shellTemp)).toMatchObject({ exitCode: 0, confined: true });
    expect(shellTemp.output).toContain('temporary');
    expect(shellTemp.output).toContain('value-1');
    expect(shellTemp.output).toContain('a&b');
  },
  60000,
);

it('constructs a fixed native containment policy without DACL fallback or inherited credentials', async () => {
  const { adapter, request, root, workspace } = await fixture();
  const scratch = path.join(root, 'work');
  await fs.mkdir(scratch);
  const policy: any = await adapter.policy(request, scratch);
  expect(policy).toMatchObject({
    version: '1.0.0',
    containment: 'processcontainer',
    fallback: { allowDaclMutation: false },
    processContainer: { leastPrivilege: false },
    network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    telemetry: { enabled: false },
  });
  expect(policy.filesystem.readonlyPaths).toContain(root);
  expect(policy.filesystem.readwritePaths).toEqual([workspace, scratch]);
  expect(policy.process.inheritDefaultEnv).toBe(false);
  expect(policy.process.env).toContain(`TEMP=${scratch}`);
  expect(policy.process.env).toContain(`GIT_DIR=${path.join(workspace, '.mercury', 'git')}`);
  expect(policy.process.env).toContain(`GIT_WORK_TREE=${workspace}`);
  expect(policy.process.env).toContain(`GIT_INDEX_FILE=${path.join(workspace, '.mercury', 'git', 'index')}`);
  expect(JSON.stringify(policy)).not.toContain('permissiveLearningMode');
});

it('limits level-one reads and preserves narrower worker write roots in full access', async () => {
  const { adapter, request, root, workspace } = await fixture();
  const scratch = path.join(root, 'work');
  await fs.mkdir(scratch);
  const levelOne: any = await adapter.policy({ ...request, mode: 1 }, scratch);
  expect(levelOne.filesystem.readonlyPaths).not.toContain(root);
  const owned = path.join(workspace, 'owned.ts');
  const worker: any = await adapter.policy({ ...request, mode: 3, confined: true, writableRoots: [owned] }, scratch);
  expect(worker.filesystem.readwritePaths).toEqual([owned, scratch]);
  expect(worker.filesystem.readwritePaths).not.toContain(workspace);
});

it('removes environment test controls, diagnostic overrides, and model credentials', () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'secret');
  vi.stubEnv('MXC_FORCE_TIER', 'unconfined');
  vi.stubEnv('WXC_FORCE_TIER', 'appcontainer-dacl');
  vi.stubEnv('MXC_DIAG_CONSOLE', '1');
  const environment = mxcHostEnvironment();
  expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
  expect(environment.MXC_FORCE_TIER).toBeUndefined();
  expect(environment.WXC_FORCE_TIER).toBeUndefined();
  expect(environment.MXC_DIAG_CONSOLE).toBeUndefined();
});

it.each([
  { tier: 'appcontainer-dacl', needsDaclAugmentation: true, probes: { baseContainerApiPresent: false } },
  { tier: 'appcontainer-bfs', needsDaclAugmentation: false, probes: { baseContainerApiPresent: false } },
  {
    tier: 'base-container',
    needsDaclAugmentation: false,
    error: 'requested scope unsupported',
    probes: { baseContainerApiPresent: true },
  },
])('does not execute a workload after a weaker or failed capability probe: %j', async (probe) => {
  const transport = vi.fn(async (_input: MxcProcessInput) => result(JSON.stringify(probe)));
  const { adapter, request } = await fixture(transport);
  await expect(adapter.execute(request, new AbortController().signal)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0].args).toContain('--probe');
});

it('probes the exact request, validates it, then executes without allowing model CLI flags', async () => {
  const policies: any[] = [];
  const transport = vi.fn(async (input: MxcProcessInput) => {
    const config = input.args[input.args.indexOf('--config') + 1];
    policies.push(JSON.parse(await fs.readFile(config, 'utf8')));
    return input.args.includes('--probe') ? supported() : result(input.args.includes('--dry-run') ? '' : 'verified');
  });
  const { adapter, request, scratch } = await fixture(transport);
  expect(await adapter.execute(request, new AbortController().signal)).toMatchObject({
    exitCode: 0,
    output: 'verified',
    confined: true,
  });
  expect(transport.mock.calls.map(([input]) => input.args[0])).toEqual(['--probe', '--dry-run', '--config']);
  expect(policies.every((policy) => policy.process.commandLine.includes('echo verified'))).toBe(true);
  expect(await fs.readdir(scratch)).toEqual([]);
});

it('does not launch after policy validation fails', async () => {
  const transport = vi.fn(async (input: MxcProcessInput) =>
    input.args.includes('--probe') ? supported() : { ...result('', 1), stderr: 'filesystem policy not supported' },
  );
  const { adapter, request } = await fixture(transport);
  await expect(adapter.execute(request, new AbortController().signal)).rejects.toThrow(
    'filesystem policy not supported',
  );
  expect(transport).toHaveBeenCalledTimes(2);
});

it('verifies packaged runtime integrity before using any capability result', async () => {
  const { adapter, runtime, request, transport } = await fixture();
  await fs.writeFile(path.join(runtime, 'wxc-exec.exe'), 'replaced');
  expect(await adapter.probe(request)).toMatchObject({
    available: false,
    reason: 'MXC runtime integrity verification failed.',
  });
  expect(transport).not.toHaveBeenCalled();
});

it('cancels active execution and awaits its shutdown before resolving cleanup', async () => {
  let launched = false;
  const transport = vi.fn(async (input: MxcProcessInput) => {
    if (input.args.includes('--probe')) return supported();
    if (input.args.includes('--dry-run')) return result();
    launched = true;
    return new Promise<MxcProcessResult>((_resolve, reject) =>
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }),
    );
  });
  const { adapter, request, scratch } = await fixture(transport);
  const pending = adapter.execute(request, new AbortController().signal);
  const rejection = expect(pending).rejects.toThrow('Project execution stopped');
  await expect.poll(() => launched).toBe(true);
  await adapter.shutdown();
  await rejection;
  expect(await fs.readdir(scratch)).toEqual([]);
});

it('fails closed on unsupported hosts without invoking an executor', async () => {
  const { runtime, scratch, request, transport } = await fixture();
  const adapter = new ProjectExecutionAdapter(runtime, scratch, { transport, platform: 'linux' });
  expect(await adapter.probe(request)).toMatchObject({ available: false });
  await expect(adapter.execute(request, new AbortController().signal)).rejects.toThrow('Windows 11');
  expect(transport).not.toHaveBeenCalled();
});

it('rejects malformed request scopes and preserves pre-cancellation', async () => {
  const { adapter, request, root, transport } = await fixture();
  await expect(adapter.policy({ ...request, writableRoots: ['relative'] }, root)).rejects.toThrow('absolute paths');
  const controller = new AbortController();
  controller.abort(new Error('Stopped before spawn'));
  await expect(adapter.execute(request, controller.signal)).rejects.toThrow('Stopped before spawn');
  expect(transport).not.toHaveBeenCalled();
});

it('keeps a confined stdio invocation policy alive until its transport closes', async () => {
  const { adapter, request, scratch } = await fixture();
  await adapter.withInvocation({ ...request, mode: 3 }, new AbortController().signal, async (invocation) => {
    expect(invocation.args[0]).toBe('--config');
    const config = JSON.parse(await fs.readFile(invocation.args[1], 'utf8'));
    expect(config.containment).toBe('processcontainer');
    expect(config.fallback.allowDaclMutation).toBe(false);
    expect(await fs.readdir(scratch)).toHaveLength(1);
  });
  expect(await fs.readdir(scratch)).toEqual([]);
});

it.runIf(process.env.MERCURY_LIVE_MXC === '1')(
  'enforces real native project writes, outside read modes, and outside write denial',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-mxc-live-'));
    temporary.push(root);
    const workspace = path.join(root, 'workspace'),
      scratch = path.join(root, 'scratch');
    await fs.mkdir(workspace);
    const outside = path.join(root, 'outside.txt'),
      denied = path.join(root, 'denied.txt');
    await fs.writeFile(outside, 'outside-read-marker');
    const adapter = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), scratch);
    const base: ProjectExecutionRequest = {
      command: 'echo native-project-write>inside.txt',
      cwd: workspace,
      workspaceRoot: workspace,
      mode: 1,
    };
    const support = await adapter.probe(base);
    expect(support, JSON.stringify(support)).toMatchObject({ available: true, tier: 'base-container' });
    const written = await adapter.execute(base, new AbortController().signal);
    expect(written, JSON.stringify(written)).toMatchObject({ exitCode: 0, confined: true });
    expect(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8')).toContain('native-project-write');
    const workerWrite = await adapter.execute(
      {
        ...base,
        mode: 3,
        confined: true,
        writableRoots: [path.join(workspace, 'inside.txt')],
        command: 'echo worker-owned>inside.txt & echo forbidden>worker-out-of-scope.txt',
      },
      new AbortController().signal,
    );
    expect(workerWrite.exitCode).not.toBe(0);
    expect(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8')).toContain('worker-owned');
    await expect(fs.stat(path.join(workspace, 'worker-out-of-scope.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const readOne = await adapter.execute({ ...base, command: `type "${outside}"` }, new AbortController().signal);
    expect(readOne.exitCode).not.toBe(0);
    expect(readOne.output).not.toContain('outside-read-marker');
    const readTwo = await adapter.execute(
      { ...base, mode: 2, command: `type "${outside}"` },
      new AbortController().signal,
    );
    expect(readTwo.exitCode).toBe(0);
    expect(readTwo.output).toContain('outside-read-marker');
    for (const mode of [1, 2] as const) {
      const write = await adapter.execute(
        { ...base, mode, command: `echo forbidden>"${denied}"` },
        new AbortController().signal,
      );
      expect(write.exitCode).not.toBe(0);
      await expect(fs.stat(denied)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const linked = path.join(workspace, 'outside-link');
    await fs.symlink(root, linked, 'junction');
    const junctionWrite = await adapter.execute(
      { ...base, mode: 2, command: 'echo forbidden>outside-link\\denied.txt' },
      new AbortController().signal,
    );
    expect(junctionWrite.exitCode, junctionWrite.output).not.toBe(0);
    await expect(fs.stat(denied)).rejects.toMatchObject({ code: 'ENOENT' });
    const composed = await adapter.execute(
      { ...base, command: `cmd /d /c "echo forbidden>\"${denied}\""` },
      new AbortController().signal,
    );
    expect(composed.exitCode).not.toBe(0);
    await expect(fs.stat(denied)).rejects.toMatchObject({ code: 'ENOENT' });
    const registryKey = `HKCU\\Software\\MercuryContainmentTest-${process.pid}-${Date.now()}`;
    const registry = await adapter.execute(
      { ...base, mode: 2, win32k: true, command: `reg add "${registryKey}" /v test /t REG_SZ /d forbidden /f` },
      new AbortController().signal,
    );
    if (registry.exitCode === 0)
      await new Promise<void>((resolve) => execFile('reg.exe', ['delete', registryKey, '/f'], () => resolve()));
    expect(registry.exitCode, registry.output).not.toBe(0);

    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local test port');
      const network = await adapter.execute(
        {
          ...base,
          mode: 2,
          win32k: true,
          command: `powershell.exe -NoProfile -NonInteractive -Command "$c=New-Object Net.Sockets.TcpClient; try {$c.Connect('127.0.0.1',${address.port}); exit 0} catch {exit 7} finally {$c.Dispose()}"`,
          timeoutMs: 3000,
        },
        new AbortController().signal,
      );
      expect(network.output).not.toContain('STATUS_DLL_INIT_FAILED');
      expect(network.exitCode, network.output).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const controller = new AbortController();
    const running = adapter.execute(
      { ...base, command: 'cmd /d /c "for /L %i in (1,1,1000000000) do @rem waiting" & echo escaped>after-cancel.txt' },
      controller.signal,
    );
    const rejection = expect(running).rejects.toThrow('live cancel');
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort(new Error('live cancel'));
    await rejection;
    await new Promise((resolve) => setTimeout(resolve, 3500));
    await expect(fs.stat(path.join(workspace, 'after-cancel.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await adapter.shutdown();
  },
  30000,
);
