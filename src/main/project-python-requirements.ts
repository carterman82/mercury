import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolFailure } from './tool-outcome';

export interface PythonConstraint { specifier: string; source: string; line: number }
export interface PythonRequirements { constraints: PythonConstraint[]; fingerprint: string; known: boolean }
type Version = [number, number, number];
const version = (value: string): Version => {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new ToolFailure('PYTHON_REQUIREMENT_UNSUPPORTED', `Unsupported Python release version: ${value}. Use stable numeric versions.`);
  const [major, minor, patch = 0] = value.split('.').map(Number);
  return [major, minor, patch];
};
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Deliberately bounded stable-release subset of Python version specifiers.
 * Unsupported syntax fails closed, rather than approximating PEP 440 semantics. */
export function pythonVersionSatisfies(value: string, specifier: string): boolean {
  const current = version(value);
  return specifier.split(',').every(part => {
    const match = /^\s*(==|!=|>=|<=|~=|>|<)\s*(\d+\.\d+(?:\.\d+)?)(\.\*)?\s*$/.exec(part);
    if (!match || (match[3] && !['==', '!='].includes(match[1])))
      throw new ToolFailure('PYTHON_REQUIREMENT_UNSUPPORTED', `Unsupported Python constraint: ${specifier}. Use stable numeric ==, !=, >=, <=, >, <, ~= constraints; wildcard equality is supported.`);
    const required = version(match[2]);
    const delta = compare(current, required);
    if (match[3]) {
      const width = match[2].split('.').length;
      const equal = current.slice(0, width).every((n, index) => n === required[index]);
      return match[1] === '==' ? equal : !equal;
    }
    switch (match[1]) {
      case '==': return delta === 0;
      case '!=': return delta !== 0;
      case '>=': return delta >= 0;
      case '<=': return delta <= 0;
      case '>': return delta > 0;
      case '<': return delta < 0;
      case '~=': return delta >= 0 && compare(current, match[2].split('.').length === 3 ? [required[0], required[1] + 1, 0] : [required[0] + 1, 0, 0]) < 0;
      default: return false;
    }
  });
}

export function compatiblePythonVersion(value: string, requirements: PythonRequirements) {
  return requirements.constraints.every(item => pythonVersionSatisfies(value, item.specifier));
}

async function localText(root: string, relative: string) {
  const file = path.join(root, relative);
  try {
    const real = await fs.realpath(file);
    const rel = path.relative(root, real);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new ToolFailure('PYTHON_REQUIREMENT_PATH', `${relative} resolves outside the project.`);
    if ((await fs.stat(real)).size > 128000) throw new ToolFailure('PYTHON_REQUIREMENT_TOO_LARGE', `${relative} exceeds the supported metadata size.`);
    return await fs.readFile(real, 'utf8');
  } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function projectPythonRequirements(root: string, expectedVersion?: string): Promise<PythonRequirements> {
  const constraints: PythonConstraint[] = [];
  const observed: [string, string | undefined][] = [];
  for (const file of ['.python-version', 'pyproject.toml', 'requirements.txt']) observed.push([file, await localText(root, file)]);
  const pin = observed[0][1];
  if (pin !== undefined) {
    const lines = pin.split(/\r?\n/);
    const index = lines.findIndex(line => line.trim() && !line.trim().startsWith('#'));
    if (index >= 0) {
      const value = lines[index].trim();
      if (!/^3\.\d{1,2}(?:\.\d+)?$/.test(value) || lines.slice(index + 1).some(line => line.trim() && !line.trim().startsWith('#')))
        throw new ToolFailure('PYTHON_REQUIREMENT_UNSUPPORTED', '.python-version must contain one stable Python 3 version; multiple runtimes/version-manager selectors require explicit review.');
      constraints.push({ source: '.python-version', line: index + 1, specifier: `==${value}${value.split('.').length === 2 ? '.*' : ''}` });
    }
  }
  let section = '';
  for (const [index, line] of (observed[1][1] ?? '').split(/\r?\n/).entries()) {
    if (/^\s*\[\s*['"]project['"]\s*\]/.test(line) || /^\s*(?:['"]requires-python['"]|(?:project|['"]project['"])\s*\.\s*(?:requires-python|['"]requires-python['"]))\s*=/.test(line) || /^\s*(?:project|['"]project['"])\s*=/.test(line))
      throw new ToolFailure('PYTHON_REQUIREMENT_UNSUPPORTED', `pyproject.toml:${index + 1}: quoted/dotted Python metadata is not supported; review it explicitly instead of assuming no constraint.`);
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) section = header[1].trim();
    if (section !== 'project' || !/^\s*requires-python\s*=/.test(line)) continue;
    const match = /^\s*requires-python\s*=\s*(['"])([^'"\\]+)\1\s*(?:#.*)?$/.exec(line);
    if (!match) throw new ToolFailure('PYTHON_REQUIREMENT_UNSUPPORTED', `pyproject.toml:${index + 1}: requires-python must be a simple quoted constraint string; unsupported TOML is not guessed.`);
    constraints.push({ source: 'pyproject.toml', line: index + 1, specifier: match[2] });
  }
  // Support the explicit legacy declaration used by existing projects. Do not
  // mistake dependency package versions for the interpreter requirement.
  for (const [index, line] of (observed[2][1] ?? '').split(/\r?\n/).entries()) {
    const range = /^\s*#\s*Python\s+(3\.\d+)\s*[-–]\s*(3\.\d+)\s+(?:required|supported)\b/i.exec(line);
    if (range) {
      const upper = version(range[2]);
      constraints.push({ source: 'requirements.txt', line: index + 1, specifier: `>=${range[1]},<${upper[0]}.${upper[1] + 1}` });
    }
  }
  if (expectedVersion) constraints.push({ source: 'setup request', line: 0, specifier: `==${expectedVersion}.*` });
  for (const item of constraints) pythonVersionSatisfies('3.11.0', item.specifier);
  const requirements = { constraints, known: constraints.length > 0,
    fingerprint: createHash('sha256').update(JSON.stringify([observed, expectedVersion])).digest('hex') };
  const boundaries = constraints.flatMap(item => [...item.specifier.matchAll(/\d+\.\d+(?:\.\d+)?/g)].map(match => version(match[0])));
  const patches = [...new Set([0, 1, 999999, ...boundaries.flatMap(v => [v[2], v[2] + 1])])];
  const satisfiable = Array.from({ length: 100 }, (_, minor) => minor).some(minor => patches.some(patch => compatiblePythonVersion(`3.${minor}.${patch}`, requirements)));
  if (!satisfiable) throw new ToolFailure('PYTHON_REQUIREMENTS_CONFLICT', 'The project Python constraints and requested version have no supported Python 3 release in common.', { required: constraints, nextAction: 'Review the cited project constraints and choose a compatible installed interpreter. Do not override the project range.' });
  return requirements;
}
