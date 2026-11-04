import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectExecutionRequest, ProjectExecutionResult } from './project-execution';
import { ToolFailure, toolFailed } from './tool-outcome';
import { projectPythonRequirements, compatiblePythonVersion, type PythonRequirements } from './project-python-requirements';

// No flags, URLs, editable installs or arbitrary requirements files. Every
// distribution and constraint is visible in the single installation approval.
const packageSpec =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:==|~=|>=|<=|!=|>|<)[0-9][A-Za-z0-9.*+!_-]*(?:,(?:==|~=|>=|<=|!=|>|<)[0-9][A-Za-z0-9.*+!_-]*)*)?$/;
export const pythonEnvironmentSchema = z
  .object({
    interpreter: z
      .string()
      .min(1)
      .max(32768)
      .refine(
        (value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value),
        'Use an absolute path to the installed Python executable.',
      ),
    environmentPath: z
      .string()
      .regex(
        /^\.venv(?:[-_][A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)?$/,
        'Use a project-local .venv or .venv_test-style directory.',
      )
      .default('.venv_test'),
    packages: z
      .array(
        z
          .string()
          .max(200)
          .regex(
            packageSpec,
            'Use a distribution name with optional extras/version constraints; no pip flags, paths or URLs.',
          ),
      )
      .max(30),
    expectedVersion: z
      .string()
      .regex(/^3\.\d{1,2}$/)
      .optional(),
    imports: z
      .array(
        z
          .string()
          .max(150)
          .regex(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type PythonEnvironmentInput = z.infer<typeof pythonEnvironmentSchema>;
export interface PythonEnvironmentPlan {
  input: PythonEnvironmentInput;
  root: string;
  interpreter: string;
  destination: string;
  python: string;
  existing: boolean;
  fingerprint: string;
  interpreterHash: string;
  requirements: PythonRequirements;
  declaredEnvironmentVersion?: string;
}
type Resolve = (root: string, value: string) => Promise<string>;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Inspect files only; no executable runs before the user reviews the plan. */
export async function planPythonEnvironment(
  root: string,
  raw: unknown,
  resolve: Resolve,
): Promise<PythonEnvironmentPlan> {
  const input = pythonEnvironmentSchema.parse(raw);
  const requirements = await projectPythonRequirements(root, input.expectedVersion);
  const interpreter = await fs.realpath(input.interpreter);
  if (!(await fs.stat(interpreter)).isFile())
    throw new ToolFailure('PYTHON_INTERPRETER_REQUIRED', 'Select an installed Python executable.');
  const destination = path.join(root, input.environmentPath);
  if ((await resolve(root, input.environmentPath)) !== destination)
    throw new ToolFailure(
      'ENVIRONMENT_PATH_CHANGED',
      'The environment directory must be a real project-local directory, not a link. Choose a fresh .venv_test-style path.',
    );
  let existing = false;
  let config = '';
  try {
    const stat = await fs.lstat(destination);
    existing = true;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ToolFailure(
        'ENVIRONMENT_NOT_VENV',
        'The selected environment path is not an ordinary directory. Nothing was replaced.',
      );
    const cfg = await fs.realpath(path.join(destination, 'pyvenv.cfg'));
    if (cfg !== path.join(destination, 'pyvenv.cfg') || (await fs.stat(cfg)).size > 16000)
      throw new ToolFailure(
        'ENVIRONMENT_NOT_VENV',
        'The existing environment configuration is linked or oversized. Nothing was replaced.',
      );
    config = await fs.readFile(cfg, 'utf8');
    if (!/^include-system-site-packages\s*=\s*false\s*$/im.test(config))
      throw new ToolFailure(
        'ENVIRONMENT_NOT_ISOLATED',
        'The existing environment exposes system packages. Choose a fresh .venv_test-style directory.',
      );
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    if (existing)
      throw new ToolFailure(
        'ENVIRONMENT_NOT_VENV',
        'The existing directory is not a Python virtual environment. Nothing was replaced. Choose a fresh .venv_test-style directory.',
      );
  }
  const python = path.join(destination, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let environmentBinary = '';
  if (existing) {
    // Unix venv interpreters are normally symlinks to the base runtime.
    const actual = await fs.realpath(python);
    if (actual !== interpreter && actual !== python)
      throw new ToolFailure(
        'ENVIRONMENT_INTERPRETER_MISMATCH',
        'The existing virtual environment points to a different Python executable. Choose a fresh environment.',
      );
    environmentBinary = digest(await fs.readFile(actual));
  }
  const interpreterHash = digest(await fs.readFile(interpreter));
  return {
    input,
    root,
    interpreter,
    destination,
    python,
    existing,
    interpreterHash,
    requirements,
    declaredEnvironmentVersion: /^version\s*=\s*(\d+\.\d+(?:\.\d+)?)/im.exec(config)?.[1],
    fingerprint: digest(
      JSON.stringify([interpreter, interpreterHash, destination, existing, config, environmentBinary, requirements.fingerprint]),
    ),
  };
}

export async function revalidatePythonEnvironment(plan: PythonEnvironmentPlan, resolve: Resolve) {
  if (
    (await fs.realpath(plan.root)) !== plan.root ||
    (await resolve(plan.root, plan.input.environmentPath)) !== plan.destination ||
    (await fs.realpath(plan.input.interpreter)) !== plan.interpreter ||
    digest(await fs.readFile(plan.interpreter)) !== plan.interpreterHash ||
    (await projectPythonRequirements(plan.root, plan.input.expectedVersion)).fingerprint !== plan.requirements.fingerprint
  )
    throw new ToolFailure(
      'ENVIRONMENT_PATH_CHANGED',
      'The reviewed interpreter or environment path changed. Setup stopped before the next phase.',
    );
}

export function pythonInstallNeedsNetwork(input: {
  command?: string;
  executable?: string;
  args?: string[];
  network?: string;
}) {
  const command = input.executable ? [input.executable, ...(input.args ?? [])].join(' ') : (input.command ?? '');
  return (
    input.network !== 'allow' &&
    !/--no-index\b/.test(command) &&
    /\bpip(?:3)?(?:\.exe)?\s+(?:--[\w-]+\s+)*install\b/i.test(command)
  );
}

const probe = `import json,sys,site,os
print(json.dumps(dict(executable=os.path.realpath(sys.executable),version=list(sys.version_info[:3]),prefix=os.path.realpath(sys.prefix),basePrefix=os.path.realpath(sys.base_prefix),userSite=site.ENABLE_USER_SITE)))`;

interface EnvironmentRuntime {
  execute(request: ProjectExecutionRequest): Promise<ProjectExecutionResult>;
  revalidate(): Promise<void>;
  mutated(): void;
  signal: AbortSignal;
}

/** Orchestrates the reviewed phases without issuing any additional approvals. */
export async function setupPythonEnvironment(
  plan: PythonEnvironmentPlan,
  base: ProjectExecutionRequest,
  runtime: EnvironmentRuntime,
) {
  const phases: { phase: string; exitCode: number | null; output: string }[] = [];
  let projectChanged = false;
  const fail = (code: string, message: string, phase: string): never => {
    throw new ToolFailure(code, message, {
      phase,
      phases,
      environmentPath: plan.input.environmentPath,
      projectChanged,
      stopProjectRun: true,
      required: plan.requirements.constraints,
      declaredEnvironmentVersion: plan.declaredEnvironmentVersion,
      nextAction:
        'Preserve the environment and test files. Ask the user to review this exact setup blocker before a new setup attempt; do not switch interpreters, mix site-packages, or retry installation automatically.',
    });
  };
  const run = async (
    phase: string,
    executable: string,
    args: string[],
    writes = false,
    network: 'allow' | 'deny' = 'deny',
  ) => {
    runtime.signal.throwIfAborted();
    await runtime.revalidate();
    if (writes && !projectChanged) {
      projectChanged = true;
      runtime.mutated();
    }
    let result: ProjectExecutionResult;
    try {
      result = await runtime.execute({
        ...base,
        command: `Python environment: ${phase}`,
        executable,
        args,
        network,
        timeoutMs: phase === 'install' ? 600000 : 120000,
      });
    } catch (error) {
      runtime.signal.throwIfAborted();
      return fail(
        'ENVIRONMENT_SETUP_FAILED',
        `${phase} could not run: ${error instanceof Error ? error.message : String(error)}`,
        phase,
      );
    }
    runtime.signal.throwIfAborted();
    phases.push({ phase, exitCode: result.exitCode, output: result.output.slice(-4000) });
    if (toolFailed(result))
      fail(
        'ENVIRONMENT_SETUP_FAILED',
        `${phase} failed: ${result.output.slice(-2000) || 'Python did not exit successfully.'}`,
        phase,
      );
    return result;
  };
  const info = async (phase: string, executable: string, isolatedSite = false) => {
    const result = await run(phase, executable, ['-I', ...(isolatedSite ? ['-S'] : []), '-c', probe]);
    try {
      const value = JSON.parse(result.output.trim());
      if (
        !Array.isArray(value.version) ||
        value.version.length !== 3 ||
        !value.version.every(Number.isInteger) ||
        typeof value.executable !== 'string' ||
        typeof value.prefix !== 'string' ||
        typeof value.basePrefix !== 'string'
      )
        throw new Error();
      return value;
    } catch {
      return fail('PYTHON_PROBE_INVALID', 'Python returned an invalid interpreter report.', phase);
    }
  };
  const selected = await info('inspect interpreter', plan.interpreter, true);
  if (selected.version[0] !== 3 || !compatiblePythonVersion(selected.version.join('.'), plan.requirements))
    throw new ToolFailure(
      'PYTHON_VERSION_MISMATCH',
      `Selected Python ${selected.version.join('.')} does not satisfy ${plan.requirements.constraints.map(item => `${item.specifier} (${item.source}:${item.line})`).join(' and ') || 'Python 3'}. Existing environment declares ${plan.declaredEnvironmentVersion ?? 'no version'}. Choose a compatible installed interpreter.`,
      { selected, environment: { declaredVersion: plan.declaredEnvironmentVersion, path: plan.destination }, required: plan.requirements.constraints, failedChecks: ['version'], phase: 'inspect interpreter', phases, projectChanged, stopProjectRun: true },
    );
  if (!plan.existing) await run('create environment', plan.interpreter, ['-I', '-m', 'venv', plan.destination], true);
  const environment = await info('validate environment', plan.python);
  const samePath = (a: string, b: string) =>
    process.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);
  const failedChecks = [
    ...(environment.version.join('.') !== selected.version.join('.') || !compatiblePythonVersion(environment.version.join('.'), plan.requirements) ? ['version'] : []),
    ...(!samePath(environment.prefix, plan.destination) ? ['prefix'] : []),
    ...(!samePath(environment.basePrefix, selected.basePrefix) ? ['basePrefix'] : []),
    ...(samePath(environment.prefix, environment.basePrefix) || environment.userSite !== false ? ['isolation'] : []),
  ];
  if (failedChecks.length) throw new ToolFailure(failedChecks.includes('version') ? 'ENVIRONMENT_VERSION_MISMATCH' : failedChecks.includes('isolation') ? 'ENVIRONMENT_NOT_ISOLATED' : 'ENVIRONMENT_PREFIX_MISMATCH',
    `Environment validation failed (${failedChecks.join(', ')}). Selected Python: ${selected.version.join('.')} at ${plan.interpreter}; environment Python: ${environment.version.join('.')} at ${plan.python}; required: ${plan.requirements.constraints.map(item => item.specifier).join(' and ') || 'Python 3'}. No packages were installed. Preserve this environment and choose the intended matching interpreter or a fresh environment path.`,
    { selected, environment, required: plan.requirements.constraints, expectedDestination: plan.destination, failedChecks, phase: 'validate environment', phases, projectChanged, stopProjectRun: true,
      nextAction: 'Review the reported versions and paths. Do not copy another interpreter’s site-packages or replace the existing environment automatically.' });
  // MXC may redirect TEMP into a package-profile directory that does not exist.
  // pip runs in-process with a private writable temp directory under this venv.
  const pip = (args: string[]) => ['-I', '-c', `import os,runpy,sys,tempfile
with tempfile.TemporaryDirectory(prefix='.mercury-pip-',dir=sys.prefix) as work:
 tempfile.tempdir=work
 os.environ['TEMP']=work;os.environ['TMP']=work;os.environ['TMPDIR']=work
 sys.argv=['pip',*sys.argv[1:]]
 runpy.run_module('pip',run_name='__main__')`, ...args];
  if (plan.input.packages.length)
    await run(
      'install',
      plan.python,
      pip([
        '--isolated',
        '--require-virtualenv',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        '--no-cache-dir',
        '--only-binary=:all:',
        '--index-url',
        'https://pypi.org/simple',
        ...plan.input.packages,
      ]),
      true,
      'allow',
    );
  await run('check dependencies', plan.python, pip(['--isolated', '--require-virtualenv', 'check']));
  const verify = `import importlib,importlib.metadata,json
names=${JSON.stringify(plan.input.packages.map((spec) => spec.split(/[\[<>=!~]/)[0]))}
modules=${JSON.stringify(plan.input.imports)}
for name in modules: importlib.import_module(name)
print(json.dumps(dict(packages={name:importlib.metadata.version(name) for name in names},imports=modules)))`;
  const report = await run('verify packages', plan.python, ['-I', '-c', verify]);
  let installed;
  try {
    installed = JSON.parse(report.output.trim().split(/\r?\n/).at(-1)!);
    if (!installed || typeof installed.packages !== 'object' || !Array.isArray(installed.imports)) throw new Error();
  } catch {
    return fail(
      'ENVIRONMENT_VERIFICATION_FAILED',
      'Package verification returned an invalid report.',
      'verify packages',
    );
  }
  const pytest = plan.input.packages.some((spec) => /^pytest(?:\b|\[)/i.test(spec));
  return {
    ready: true,
    environmentPath: plan.input.environmentPath,
    interpreter: plan.python,
    version: environment.version.join('.'),
    ...installed,
    phases,
    projectChanged,
    verification: 'Environment setup only; the project tests have not run.',
    nextAction: {
      tool: 'run_project_process',
      arguments: {
        executable: plan.python,
        args: pytest ? ['-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-v'] : ['-B', '-m', 'unittest', 'discover', '-v'],
        purpose: 'test',
      },
    },
  };
}
