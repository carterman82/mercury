import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { projectPythonRequirements, compatiblePythonVersion, pythonVersionSatisfies } from './project-python-requirements';
import { launcherPythonCandidates, discoverProjectPython } from './project-python-discovery';
import { inspectProjectTarget } from './project-target';
const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-metadata-')); roots.push(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it('intersects project metadata and rejects incompatible model-selected versions', async () => {
  const root = await fixture({ 'pyproject.toml': '[project]\nrequires-python = ">=3.11,<3.13"', 'requirements.txt': '# Python 3.11-3.12 required\nrequests==2.32.0' });
  const req = await projectPythonRequirements(root);
  expect(compatiblePythonVersion('3.12.9', req)).toBe(true); expect(compatiblePythonVersion('3.13.15', req)).toBe(false);
  expect(req.constraints).toHaveLength(2);
  await expect(projectPythonRequirements(root, '3.13')).rejects.toThrow('no supported');
  await fs.writeFile(path.join(root, '.python-version'), '3.11.9');
  expect(compatiblePythonVersion('3.12.0', await projectPythonRequirements(root))).toBe(false);
});
it.each(['[project]\n"requires-python" = "<3.13"', '["project"]\nrequires-python = "<3.13"', '[project]\nrequires-python = """<3.13"""', 'project = { requires-python = "<3.13" }', 'project . requires-python = "<3.13"'])('fails closed for unsupported TOML: %s', async text => {
  await expect(projectPythonRequirements(await fixture({ 'pyproject.toml': text }))).rejects.toMatchObject({ code: 'PYTHON_REQUIREMENT_UNSUPPORTED' });
});
it('implements stable specifier boundaries and rejects unsupported releases', () => {
  expect(pythonVersionSatisfies('3.12.2', '>3.12.1,<3.12.3')).toBe(true);
  expect(pythonVersionSatisfies('3.13.0', '~=3.12.1')).toBe(false);
  expect(pythonVersionSatisfies('3.12.9', '==3.12.*,!=3.12.8')).toBe(true);
  expect(() => pythonVersionSatisfies('3.12.0', '>=3.12rc1')).toThrow('Unsupported');
});
it('parses launcher registrations and never treats aliases as proven absence', async () => {
  expect(launcherPythonCandidates(' -V:3.12 * C:\\Python312\\python.exe\n -V:3.11 C:\\Python311\\python.exe')).toHaveLength(2);
  const root = await fixture({ 'pyproject.toml': '[project]\nrequires-python = ">3.12.1,<3.12.3"' });
  const output = await discoverProjectPython(root, ' -V:3.12 C:\\missing\\python.exe\n -V:3.12 C:\\WindowsApps\\python.exe');
  const alias = output.candidates.find(item => item.alias)!;
  expect(alias).toMatchObject({ verified: false, compatible: null, availability: 'unknown' });
  expect(output.recommended).toBeNull();
});
it('routes native model work by files and preserves an explicit mixed-project entrypoint', async () => {
  const root = await fixture({ 'main.py': 'import onnxruntime\n# local model', 'requirements.txt': 'onnxruntime', 'index.html': '<script>navigator.gpu</script>' });
  expect((await inspectProjectTarget(root)).kind).toBe('general');
  await fs.writeFile(path.join(root, 'package.json'), '{"dependencies":{"@huggingface/transformers":"3.6.1"}}');
  expect((await inspectProjectTarget(root)).kind).toBe('browser_model');
  expect(await inspectProjectTarget(root, 'main.py')).toMatchObject({ kind: 'general', entryPoint: 'main.py' });
});
