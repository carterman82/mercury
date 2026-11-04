import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectPythonRequirements, compatiblePythonVersion } from './project-python-requirements';

export interface PythonCandidate {
  path: string; source: string; declaredVersion?: string; alias: boolean;
  verified: false; compatible: boolean | null; availability: 'found' | 'unknown'; note?: string;
}
export function pythonSearchRoots(environment = process.env, platform = process.platform) {
  return platform === 'win32'
    ? [...new Set([environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs/Python'), environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Microsoft/WindowsApps'), environment.ProgramFiles, `${environment.SystemDrive ?? 'C:'}\\`].filter((value): value is string => Boolean(value)))]
    : ['/usr/bin', '/usr/local/bin', ...(environment.HOME ? [path.join(environment.HOME, '.local/bin')] : [])];
}

export async function findPythonLauncher() {
  if (process.platform !== 'win32') return undefined;
  for (const filename of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Python/Launcher/py.exe'), process.env.SystemRoot && path.join(process.env.SystemRoot, 'py.exe')].filter((value): value is string => Boolean(value))) {
    try { const actual = await fs.realpath(filename); if ((await fs.stat(actual)).isFile()) return { path: actual, hash: createHash('sha256').update(await fs.readFile(actual)).digest('hex') }; } catch { /* Missing launcher is not proof Python is absent. */ }
  }
}

export function launcherPythonCandidates(output: string): { path: string; version?: string }[] {
  return output.split(/\r?\n/).flatMap(line => {
    const filename = /([A-Za-z]:\\.+?\.exe)\s*$/i.exec(line)?.[1];
    if (!filename) return [];
    return [{ path: filename, version: /3\.\d+(?:\.\d+)?/.exec(line.slice(0, line.indexOf(filename)))?.[0] }];
  }).slice(0, 100);
}

/** Metadata inventory only. No interpreter, launcher, uv or installer is run. */
export async function discoverProjectPython(root: string, launcherOutput?: string) {
  const requirements = await projectPythonRequirements(root);
  const candidates: PythonCandidate[] = [];
  const add = async (filename: string, source: string, declaredVersion?: string) => {
    if (candidates.length >= 200) return;
    const alias = /[\\/]WindowsApps[\\/]/i.test(filename);
    let resolved = filename, availability: PythonCandidate['availability'] = 'found';
    try { resolved = await fs.realpath(filename); if (!(await fs.stat(resolved)).isFile()) return; }
    catch { if (!alias && source !== 'launcher registration') return; availability = 'unknown'; }
    if (candidates.some(item => process.platform === 'win32' ? item.path.toLowerCase() === resolved.toLowerCase() : item.path === resolved)) return;
    let compatible: boolean | null = null;
    if (declaredVersion && requirements.known) {
      // A major/minor hint is not a verified patch version. Only reject when
      // every stable patch at this minor is outside the supported constraints.
      const hasPatch = declaredVersion.split('.').length === 3;
      compatible = hasPatch ? compatiblePythonVersion(declaredVersion, requirements) :
        [0, 1, 99, 999999, ...requirements.constraints.flatMap(item => [...item.specifier.matchAll(/\d+\.\d+\.(\d+)/g)].flatMap(match => [Number(match[1]), Number(match[1]) + 1]))].some(patch => compatiblePythonVersion(`${declaredVersion}.${patch}`, requirements)) ? null : false;
    }
    candidates.push({ path: resolved, source, declaredVersion, alias, verified: false, compatible, availability,
      ...(alias ? { note: 'Windows Store/alias path: installation may exist. A launch failure under isolation means unknown usability, never “not installed”.' } : {}) });
  };
  for (const dir of ['.venv', '.venv_test', 'venv']) {
    try {
      const cfgPath = await fs.realpath(path.join(root, dir, 'pyvenv.cfg'));
      const relative = path.relative(root, cfgPath);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || (await fs.stat(cfgPath)).size > 16000) continue;
      const cfg = await fs.readFile(cfgPath, 'utf8');
      const declared = /^version\s*=\s*(3\.\d+(?:\.\d+)?)/im.exec(cfg)?.[1];
      const executable = /^executable\s*=\s*(.+)$/im.exec(cfg)?.[1].trim();
      if (executable && path.isAbsolute(executable)) await add(executable, `project ${dir}/pyvenv.cfg`, declared);
      await add(path.join(root, dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), `project ${dir}`, declared);
    } catch { /* Broken/missing venv doesn't establish absence of other runtimes. */ }
  }
  if (launcherOutput) for (const item of launcherPythonCandidates(launcherOutput)) await add(item.path, 'launcher registration', item.version);
  for (const directory of pythonSearchRoots()) {
    try {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).slice(0, 1000)) {
        if (entry.isDirectory() && /^(?:Python3\d+|PythonSoftwareFoundation\.Python\.3\.\d+_.+)$/i.test(entry.name))
          await add(path.join(directory, entry.name, 'python.exe'), 'standard installation metadata', (/3\.\d+/.exec(entry.name)?.[0] ?? (/^Python3(\d+)/i.exec(entry.name)?.[1] ? `3.${/^Python3(\d+)/i.exec(entry.name)![1]}` : undefined)));
        else if ((entry.isFile() || entry.isSymbolicLink()) && /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(entry.name)) await add(path.join(directory, entry.name), 'standard executable metadata');
      }
    } catch { /* Inaccessible metadata is reported by unknown candidates, not absence claims. */ }
  }
  candidates.sort((a, b) => Number(a.compatible === false) - Number(b.compatible === false) || Number(!a.source.startsWith('project')) - Number(!b.source.startsWith('project')) || Number(a.alias) - Number(b.alias) || a.path.localeCompare(b.path));
  return { requirements: requirements.constraints, candidates,
    recommended: candidates.find(item => item.compatible === true && item.availability === 'found' && !item.alias)?.path ?? null,
    nextAction: 'Choose a candidate satisfying the project constraint and inspect it through an approved setup/probe. Metadata is not an executed version check. Never install Python because an isolated launch failed. includeLauncher:true requests a fixed read-only py -0p listing when available; it does not install runtimes.' };
}
