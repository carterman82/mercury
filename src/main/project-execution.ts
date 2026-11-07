import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mercuryProjectGitEnvironment } from './project-git-environment';

export const MXC_RUNTIME_VERSION = '1.0.1';
export const MXC_CONTRACT_VERSION = '1.0.0';
export const MXC_RELEASE_ARCHIVE_SHA256 = '0e832239454ba7fcd338ff56218a287eef4c0a01c1484084b869f55feff8abe9';

/** Constructed by Mercury after authorization, never directly from model claims. */
export interface ProjectExecutionRequest {
  command: string;
  executable?: string;
  args?: string[];
  stdin?: string;
  cwd: string;
  mode: 1 | 2 | 3;
  workspaceRoot: string;
  readableRoots?: string[];
  writableRoots?: string[];
  network?: 'deny' | 'allow';
  loopback?: boolean;
  /** Reviewed Win32 initialization capability required by Node/.NET on Windows. */
  win32k?: boolean;
  /** Worker execution remains confined even when Main has full access. */
  confined?: boolean;
  /** Host-only: set after a one-shot approval; never exposed in model schemas. */
  approvedNative?: boolean;
  timeoutMs?: number;
  /** Trusted host runtime settings; the model command schema does not expose environment overrides. */
  environment?: Record<string, string>;
}
export interface ProjectExecutionResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  confined: boolean;
}

/** Evidence of a possible access restriction, not proof that the sandbox caused it.
 * Never interpret ordinary test failures, missing modules or connection refusal as permission grants. */
export function possibleSandboxConflict(result: ProjectExecutionResult): boolean {
  return result.confined && !result.timedOut && result.exitCode !== 0 &&
    /\b(?:EACCES|EPERM|WSAEACCES)\b|permission denied|access (?:is )?denied|operation not permitted|WinError (?:5|10013)\b|forbidden by (?:its )?access permissions|(?:sandbox|network|filesystem|file system)\s+(?:access\s+)?(?:blocked|denied)/i.test(result.output);
}
export interface ProjectExecutionSupport {
  available: boolean;
  reason?: string;
  version: typeof MXC_RUNTIME_VERSION;
  tier?: 'base-container';
}
export interface ProjectExecutionInvocation {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}
export interface MxcProcessInput {
  executable: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  stdin?: string;
}
export interface MxcProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type MxcTransport = (input: MxcProcessInput) => Promise<MxcProcessResult>;
export interface ProjectExecutionOptions {
  /** Explicit executable/library directories needed by installed project tooling. */
  runtimeReadRoots?: string[];
  /** Tests can substitute a transport; production uses the verified executable. */
  transport?: MxcTransport;
  platform?: NodeJS.Platform;
  deviceReadRoots?: () => Promise<string[]>;
}

function validPath(value: string): boolean {
  return Boolean(value) && path.isAbsolute(value) && !value.includes('\0');
}
async function canonical(value: string): Promise<string> {
  if (!validPath(value)) throw new Error('Execution scopes require absolute paths.');
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function validateProcess(request: ProjectExecutionRequest) {
  if (request.executable === undefined) return;
  if (
    !request.executable ||
    /[\0\r\n]/.test(request.executable) ||
    !Array.isArray(request.args) ||
    request.args.length > 100 ||
    request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    (request.stdin?.length ?? 0) > 512000
  )
    throw new Error(
      'Invalid structured process. Supply an executable, argument strings and at most 512,000 characters of stdin.',
    );
}
/** Windows CreateProcess quoting, never shell escaping. */
function processArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** Do not inherit environment-based MXC test/fallback controls or provider credentials. */
export function mxcHostEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'SystemRoot',
    'WINDIR',
    'SystemDrive',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
  ]) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return result;
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
    return;
  }
  const system = process.env.SystemRoot;
  if (!system || !path.isAbsolute(system)) throw new Error('Cannot locate Windows process-tree termination.');
  await new Promise<void>((resolve, reject) => {
    execFile(
      path.join(system, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 15000 },
      (error) => {
        // taskkill reports 128 if the process has already exited.
        if (error && Number((error as any).code) !== 128) reject(error);
        else resolve();
      },
    );
  });
}

/** No shell launch: the trusted MXC executable receives only host-built arguments. */
export const executeMxcProcess: MxcTransport = (input) =>
  new Promise((resolve, reject) => {
    input.signal.throwIfAborted();
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      env: input.env,
      shell: false,
      stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {}); // Early child exit can close stdin before consumption.
    if (input.stdin !== undefined) child.stdin?.end(input.stdin, 'utf8');
    let stdout = '',
      stderr = '',
      timedOut = false,
      finished = false;
    let termination: Promise<void> | undefined;
    const stop = () => {
      if (!termination && child.pid && child.exitCode === null && child.signalCode === null) {
        termination = terminateTree(child.pid);
        void termination.catch(() => {}); // Observed at close; do not emit an early unhandled rejection.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const value = String(chunk);
      if (stream === 'stdout') stdout = (stdout + value).slice(-1_000_000);
      else stderr = (stderr + value).slice(-1_000_000);
      input.onOutput?.(stream, value);
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    input.signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', stop);
    };
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    });
    child.once('close', async (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        await termination;
        input.signal.throwIfAborted();
        resolve({ exitCode: code, stdout, stderr, timedOut });
      } catch (error) {
        reject(error);
      }
    });
    if (input.signal.aborted) stop();
  });

export class ProjectExecutionAdapter {
  private active = new Map<AbortController, Promise<unknown>>();
  private transport: MxcTransport;
  constructor(
    readonly runtimeDirectory: string,
    private scratchRoot: string,
    private options: ProjectExecutionOptions = {},
  ) {
    this.transport = options.transport ?? executeMxcProcess;
  }

  private async executor(): Promise<string> {
    const root = await fs.realpath(this.runtimeDirectory);
    const record = JSON.parse(await fs.readFile(path.join(root, 'runtime.json'), 'utf8'));
    if (
      record.version !== MXC_RUNTIME_VERSION ||
      record.contractVersion !== MXC_CONTRACT_VERSION ||
      !record.files ||
      typeof record.files !== 'object' ||
      !record.files['wxc-exec.exe']
    )
      throw new Error('The pinned MXC runtime manifest is missing or incompatible.');
    for (const [relative, expected] of Object.entries(record.files)) {
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some((part) => part === '..') ||
        typeof expected !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expected)
      )
        throw new Error('Invalid MXC runtime manifest.');
      const filename = await fs.realpath(path.join(root, relative));
      if (!within(root, filename) || digest(await fs.readFile(filename)) !== expected)
        throw new Error('MXC runtime integrity verification failed.');
    }
    return path.join(root, 'wxc-exec.exe');
  }

  private async volumes(): Promise<string[]> {
    if (this.options.deviceReadRoots) return this.options.deviceReadRoots();
    const result: string[] = [];
    for (let index = 65; index <= 90; index++) {
      const drive = `${String.fromCharCode(index)}:\\`;
      if (
        await fs.stat(drive).then(
          (stat) => stat.isDirectory(),
          () => false,
        )
      )
        result.push(drive);
    }
    return result;
  }

  async policy(request: ProjectExecutionRequest, scratch: string): Promise<object> {
    validateProcess(request);
    if (
      ![1, 2, 3].includes(request.mode) ||
      !request.command.trim() ||
      request.command.length > 10000 ||
      request.command.includes('\0')
    )
      throw new Error('Invalid project command.');
    if (request.network !== undefined && !['allow', 'deny'].includes(request.network))
      throw new Error('Invalid execution network policy.');
    const timeout = request.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000)
      throw new Error('Execution timeout must be between 1 ms and one hour.');
    const workspace = await canonical(request.workspaceRoot);
    const cwd = await canonical(request.cwd);
    const write = await Promise.all((request.writableRoots ?? [workspace]).map(canonical));
    const runtime = [
      process.env.SystemRoot,
      ...(request.executable ? [path.dirname(process.execPath)] : []),
      ...(this.options.runtimeReadRoots ?? []),
    ].filter((value): value is string => Boolean(value));
    const device = request.mode === 2 || request.mode === 3 ? await this.volumes() : [];
    const read = await Promise.all([workspace, ...runtime, ...device, ...(request.readableRoots ?? [])].map(canonical));
    const work = await canonical(scratch);
    const hostEnvironment = mxcHostEnvironment();
    for (const [key, value] of Object.entries(request.environment ?? {}))
      if (
        !/^(?:ELECTRON_RUN_AS_NODE|npm_config_[a-z_]+|PIP_CONFIG_FILE)$/.test(key) ||
        value.includes('\0') ||
        (key === 'PIP_CONFIG_FILE' && value !== (process.platform === 'win32' ? 'nul' : '/dev/null'))
      )
        throw new Error('Unsupported host execution environment override.');
    const environment = Object.entries(
      mercuryProjectGitEnvironment(
        {
          PATH: hostEnvironment.PATH ?? '',
          PATHEXT: hostEnvironment.PATHEXT ?? '',
          SystemRoot: hostEnvironment.SystemRoot ?? '',
          WINDIR: hostEnvironment.WINDIR ?? hostEnvironment.SystemRoot ?? '',
          ComSpec: hostEnvironment.ComSpec ?? '',
          TEMP: work,
          TMP: work,
          TMPDIR: work,
          HOME: work,
          USERPROFILE: work,
          APPDATA: work,
          LOCALAPPDATA: work,
          DOTNET_CLI_HOME: work,
          npm_config_cache: path.join(work, 'npm-cache'),
          ...request.environment,
        },
        workspace,
        work,
      ),
    ).map(([key, value]) => `${key}=${value}`);
    const shell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe';
    // Windows package initialization rewrites TEMP/TMP to an uncreated package
    // directory. Restore the authorized scratch directory inside containment.
    // CMD expands environment references before running the command line. Create
    // its redirected directories so both %TEMP% references and child processes
    // work without another parsing layer or a Node/UI capability for the shell.
    const tempSetup = ['TEMP', 'TMP'].map((name) => `(if not exist "%${name}%" mkdir "%${name}%")`).join(' & ');
    let commandLine = `"${shell}" /d /s /c "${tempSetup} & ${request.command}"`;
    if (request.executable) {
      const launch = { executable: request.executable, args: request.args, stdin: request.stdin };
      const launcher = path.join(work, 'structured-process.cjs');
      await fs.writeFile(
        launcher,
        `const {spawn}=require('node:child_process');\nconst request=${JSON.stringify(launch)};\nconst temp=${JSON.stringify(work)};\nconst env={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp};\nconst child=spawn(request.executable,request.args,{shell:false,windowsHide:true,env,stdio:['pipe','inherit','inherit']});\nchild.stdin.on('error',()=>{});child.stdin.end(request.stdin??'','utf8');child.on('error',error=>{console.error(error.message);process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});`,
        { flag: 'wx' },
      );
      if (!environment.some((value) => value.startsWith('ELECTRON_RUN_AS_NODE=')))
        environment.push('ELECTRON_RUN_AS_NODE=1');
      // Loading a main script makes Node realpath every ancestor, which would
      // require reading drive roots in level 1. Read this exact authorized file
      // instead of widening filesystem access for the module loader.
      commandLine = [
        process.execPath,
        '-e',
        "new Function('require',require('node:fs').readFileSync(process.argv[1],'utf8'))(require)",
        launcher,
      ]
        .map(processArgument)
        .join(' ');
    }
    return {
      version: MXC_CONTRACT_VERSION,
      containment: 'processcontainer',
      fallback: { allowDaclMutation: false },
      filesystem: {
        readonlyPaths: [...new Set(read.filter((root) => !write.some((writable) => within(writable, root))))],
        readwritePaths: [...new Set([...write, work])],
      },
      network: {
        egress: { default: request.network ?? 'deny' },
        ingress: { default: 'deny', hostLoopback: request.loopback ? 'allow' : 'deny' },
      },
      process: {
        commandLine,
        cwd,
        env: environment,
        inheritDefaultEnv: false,
        timeout,
      },
      // PSEC enforces the native policy directly. Its contract rejects the
      // legacy AppContainer LPAC switch; setting it would force a DACL fallback.
      processContainer: { leastPrivilege: false },
      lifecycle: { destroyOnExit: true, preservePolicy: false },
      telemetry: { enabled: false },
      ui: { disable: !request.win32k, clipboard: 'none', injection: false },
    };
  }

  private async withPolicy<T>(
    request: ProjectExecutionRequest,
    signal: AbortSignal,
    operation: (executable: string, config: string) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const executable = await this.executor();
    await fs.mkdir(this.scratchRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(this.scratchRoot, 'execution-'));
    try {
      const work = path.join(directory, 'work');
      await fs.mkdir(work);
      const config = path.join(directory, 'request.json');
      await fs.writeFile(config, JSON.stringify(await this.policy(request, work)), { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      return await operation(executable, config);
    } finally {
      // This directory was created above, not derived from model-controlled paths.
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  private async probeConfig(executable: string, config: string, signal: AbortSignal): Promise<ProjectExecutionSupport> {
    const result = await this.transport({
      executable,
      args: ['--probe', '--config', config],
      env: mxcHostEnvironment(),
      timeoutMs: 15000,
      signal,
    });
    if (result.timedOut || result.exitCode !== 0)
      return {
        available: false,
        version: MXC_RUNTIME_VERSION,
        reason: result.stderr.trim() || 'Native Windows containment capability probe failed.',
      };
    let output: any;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      return { available: false, version: MXC_RUNTIME_VERSION, reason: 'MXC returned an invalid capability response.' };
    }
    if (
      output.tier !== 'base-container' ||
      output.needsDaclAugmentation !== false ||
      output.error ||
      output.probes?.baseContainerApiPresent !== true ||
      !Array.isArray(output.warnings) ||
      output.warnings.length
    )
      return {
        available: false,
        version: MXC_RUNTIME_VERSION,
        reason: String(
          output.error ??
            (output.warnings?.length
              ? output.warnings.join('; ')
              : 'The required native Windows filesystem enforcement is unavailable; weaker fallback is disabled.'),
        ),
      };
    return { available: true, version: MXC_RUNTIME_VERSION, tier: 'base-container' };
  }

  async probe(
    request?: ProjectExecutionRequest,
    signal = new AbortController().signal,
  ): Promise<ProjectExecutionSupport> {
    if ((this.options.platform ?? process.platform) !== 'win32')
      return {
        available: false,
        version: MXC_RUNTIME_VERSION,
        reason: 'Restricted execution requires supported native Windows 11 containment.',
      };
    const context = request ?? {
      command: 'echo Mercury containment probe',
      cwd: this.scratchRoot,
      workspaceRoot: this.scratchRoot,
      mode: 1 as const,
    };
    try {
      return await this.withPolicy(context, signal, (executable, config) =>
        this.probeConfig(executable, config, signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      return {
        available: false,
        version: MXC_RUNTIME_VERSION,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(
    request: ProjectExecutionRequest,
    signal: AbortSignal,
    onOutput?: MxcProcessInput['onOutput'],
  ): Promise<ProjectExecutionResult> {
    signal.throwIfAborted();
    validateProcess(request);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const native = (request.mode === 3 || request.approvedNative === true) && !request.confined;
    if (!native && (this.options.platform ?? process.platform) !== 'win32')
      throw new Error('Restricted execution requires supported native Windows 11 containment.');
    const operation = native
      ? (async () => {
          if (
            !request.command.trim() ||
            request.command.length > 10000 ||
            request.command.includes('\0') ||
            !validPath(request.cwd)
          )
            throw new Error('Invalid project command.');
          const timeout = request.timeoutMs ?? 120000;
          if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000)
            throw new Error('Execution timeout must be between 1 ms and one hour.');
          const shell =
            process.platform === 'win32'
              ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
              : '/bin/sh';
          const args = process.platform === 'win32' ? ['/d', '/s', '/c', request.command] : ['-c', request.command];
          const result = await executeMxcProcess({
            executable: request.executable ?? shell,
            args: request.executable ? request.args! : args,
            stdin: request.stdin,
            env: mercuryProjectGitEnvironment({ ...process.env, ...request.environment }, request.workspaceRoot),
            timeoutMs: timeout,
            signal: combined,
            onOutput,
            cwd: request.cwd,
          });
          combined.throwIfAborted();
          return {
            exitCode: result.exitCode,
            output: (result.stdout + result.stderr).slice(-40000),
            timedOut: result.timedOut,
            confined: false,
          };
        })()
      : this.withPolicy(request, combined, async (executable, config) => {
          const support = await this.probeConfig(executable, config, combined);
          if (!support.available) throw new Error(support.reason);
          const validation = await this.transport({
            executable,
            args: ['--dry-run', '--config', config],
            env: mxcHostEnvironment(),
            timeoutMs: 15000,
            signal: combined,
          });
          if (validation.timedOut || validation.exitCode !== 0)
            throw new Error(validation.stderr.trim() || 'The execution policy could not be enforced.');
          const result = await this.transport({
            executable,
            args: ['--config', config],
            env: mxcHostEnvironment(),
            timeoutMs: (request.timeoutMs ?? 120000) + 15000,
            signal: combined,
            onOutput,
          });
          combined.throwIfAborted();
          return {
            exitCode: result.exitCode,
            output: (result.stdout + result.stderr).slice(-40000),
            timedOut: result.timedOut,
            confined: true,
          };
        });
    this.active.set(controller, operation);
    try {
      return await operation;
    } finally {
      this.active.delete(controller);
    }
  }

  /**
   * Keeps the verified policy alive for an owned stdio transport such as MCP.
   * The callback MUST stop its process tree on signal abort and await transport
   * closure before returning; adapter shutdown awaits this callback's cleanup.
   * Always confined, including a plugin requested by a full-access Main agent.
   */
  async withInvocation<T>(
    request: ProjectExecutionRequest,
    signal: AbortSignal,
    operation: (invocation: ProjectExecutionInvocation) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if ((this.options.platform ?? process.platform) !== 'win32')
      throw new Error('Restricted execution requires supported native Windows 11 containment.');
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const pending = this.withPolicy({ ...request, confined: true }, combined, async (executable, config) => {
      const support = await this.probeConfig(executable, config, combined);
      if (!support.available) throw new Error(support.reason);
      const validation = await this.transport({
        executable,
        args: ['--dry-run', '--config', config],
        env: mxcHostEnvironment(),
        timeoutMs: 15000,
        signal: combined,
      });
      if (validation.timedOut || validation.exitCode !== 0)
        throw new Error(validation.stderr.trim() || 'The execution policy could not be enforced.');
      combined.throwIfAborted();
      const result = await operation({
        executable,
        args: ['--config', config],
        env: mxcHostEnvironment(),
        signal: combined,
      });
      combined.throwIfAborted();
      return result;
    });
    this.active.set(controller, pending);
    try {
      return await pending;
    } finally {
      this.active.delete(controller);
    }
  }

  async shutdown(): Promise<void> {
    for (const controller of this.active.keys()) controller.abort(new Error('Project execution stopped.'));
    await Promise.allSettled([...this.active.values()]);
  }
}
