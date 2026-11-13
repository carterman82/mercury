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
      mode: 2,
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

it('allows local reads but no project writes in read-only mode and preserves worker roots', async () => {
  const { adapter, request, root, workspace } = await fixture();
  const scratch = path.join(root, 'work');
  await fs.mkdir(scratch);
  const levelOne: any = await adapter.policy({ ...request, mode: 1 }, scratch);
  expect(levelOne.filesystem.readonlyPaths).toContain(root);
  expect(levelOne.filesystem.readwritePaths).toEqual([scratch]);
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

it('retains nested metadata protections and explicit denials under broad writable roots', async () => {
  const { adapter, request, root, workspace } = await fixture();
  const scratch = path.join(root, 'protected-work');
  await fs.mkdir(scratch);
  const denied = path.join(workspace, 'secret.txt');
  const policy: any = await adapter.policy({ ...request, deniedRoots: [denied] }, scratch);
  for (const name of ['.git', '.agents', '.codex', '.aws']) expect(policy.filesystem.readonlyPaths).toContain(path.join(workspace, name));
  expect(policy.filesystem.readwritePaths).toContain(workspace);
  expect(policy.filesystem.deniedPaths).toEqual([denied]);
  await expect(adapter.execute({ ...request, deniedRoots: [denied] }, new AbortController().signal)).rejects.toThrow('deny-path enforcement');
});

it.runIf(process.env.MERCURY_LIVE_MXC === '1')('enforces nested metadata protection, explicit denials and read-only commands on Windows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-native-policy-'));
  temporary.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  for (const name of ['.git', '.agents', '.codex', '.aws']) {
    await fs.mkdir(path.join(workspace, name));
    await fs.writeFile(path.join(workspace, name, 'marker'), 'original');
  }
  const denied = path.join(workspace, 'secret.txt');
  await fs.writeFile(denied, 'must-not-be-readable');
  const adapter = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(root, 'scratch'));
  const script = `const fs=require('node:fs');
    for(const name of ['.git','.agents','.codex','.aws']) {
      try {fs.writeFileSync(name+'/marker','changed'); throw new Error('PROTECTED WRITE SUCCEEDED: '+name)} catch(e) {if(!['EACCES','EPERM'].includes(e.code))throw e;}
    }
    try{fs.readFileSync('secret.txt');throw new Error('DENIED READ SUCCEEDED')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}
    fs.writeFileSync('ordinary.txt','allowed');console.log('native protections verified');`;
  const request: ProjectExecutionRequest = { command: 'verify protected files', executable: process.execPath, args: ['-'], stdin: script, mode: 2, workspaceRoot: workspace, cwd: workspace, win32k: true, deniedRoots: [denied] };
  const result = await adapter.execute(request, new AbortController().signal);
  expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, confined: true });
  expect(result.output).toContain('native protections verified');
  for (const name of ['.git', '.agents', '.codex', '.aws']) expect(await fs.readFile(path.join(workspace, name, 'marker'), 'utf8')).toBe('original');
  expect(await fs.readFile(path.join(workspace, 'ordinary.txt'), 'utf8')).toBe('allowed');
  const diagnostic = await adapter.execute({ ...request, mode: 1, stdin: `const fs=require('node:fs');try{fs.writeFileSync('forbidden.txt','bad');throw new Error('READONLY WRITE SUCCEEDED')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(),'scratch.txt'),'ok');console.log('readonly verified');` }, new AbortController().signal);
  expect(diagnostic, JSON.stringify(diagnostic)).toMatchObject({ exitCode: 0, confined: true });
  expect(diagnostic.output).toContain('readonly verified');
  await expect(fs.stat(path.join(workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 60000);

it.runIf(process.env.MERCURY_LIVE_MXC === '1' && Boolean(process.env.MERCURY_LIVE_PYTHON))('runs an installed Python under workspace-write and read-only confinement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-python-policy-'));
  temporary.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const adapter = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(root, 'scratch'));
  const request: ProjectExecutionRequest = { command: 'Python sandbox smoke', executable: process.env.MERCURY_LIVE_PYTHON!, args: ['-I', '-B', '-c', 'import pathlib;pathlib.Path("python.txt").write_text("verified");print("python confined")'], mode: 2, workspaceRoot: workspace, cwd: workspace, win32k: true };
  const written = await adapter.execute(request, new AbortController().signal);
  expect(written, JSON.stringify(written)).toMatchObject({ exitCode: 0, confined: true });
  expect(await fs.readFile(path.join(workspace, 'python.txt'), 'utf8')).toBe('verified');
  const denied = await adapter.execute({ ...request, mode: 1 }, new AbortController().signal);
  expect(denied.exitCode, denied.output).not.toBe(0);
  expect(denied.output).toMatch(/PermissionError|denied/);
}, 45000);

it('terminates a timed-out native process before it can write later effects', async () => {
  const { adapter, request, workspace } = await fixture();
  const late = path.join(workspace, 'late.txt');
  const executed = await adapter.execute({ ...request, mode: 3, timeoutMs: 200, executable: process.execPath, args: ['-e', `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'escaped'),1500)`] }, new AbortController().signal);
  expect(executed).toMatchObject({ timedOut: true, confined: false });
  await expect(fs.stat(late)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.runIf(process.env.MERCURY_LIVE_MXC === '1')('ends sandbox descendants when their foreground owner exits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-descendants-'));
  temporary.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const adapter = new ProjectExecutionAdapter(path.resolve('.build-resources/mxc-runtime'), path.join(root, 'scratch'));
  const child = `require('node:fs').writeFileSync('started.txt','yes');console.log('ready');setTimeout(()=>require('node:fs').writeFileSync('escaped.txt','bad'),1500)`;
  const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>process.exit(0));child.once('error',e=>{console.error(e);process.exit(1)});`;
  const executed = await adapter.execute({ command: 'descendant lifetime smoke', executable: process.execPath, args: ['-'], stdin: parent, mode: 2, workspaceRoot: workspace, cwd: workspace, win32k: true }, new AbortController().signal);
  expect(executed, JSON.stringify(executed)).toMatchObject({ exitCode: 0, confined: true });
  expect(await fs.readFile(path.join(workspace, 'started.txt'), 'utf8')).toBe('yes');
  await new Promise(resolve => setTimeout(resolve, 1800));
  await expect(fs.stat(path.join(workspace, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 45000);

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
      mode: 2,
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
    const readOne = await adapter.execute({ ...base, mode: 1, command: `type "${outside}"` }, new AbortController().signal);
    expect(readOne.exitCode).toBe(0);
    expect(readOne.output).toContain('outside-read-marker');
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
