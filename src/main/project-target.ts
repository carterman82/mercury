import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ToolFailure } from './tool-outcome';
import type { ProjectVerificationTarget } from '../shared/types';
export type { ProjectVerificationTarget } from '../shared/types';

/** Missing/renamed task files must not prevent the model from repairing selection. */
export async function reconcileProjectTarget(root: string, entryPoint?: string): Promise<ProjectVerificationTarget> {
  try { return await inspectProjectTarget(root, entryPoint); }
  catch (error) {
    return { kind: 'unknown', entryPoint, sources: [], reason: `Automatic target inspection could not establish the task type: ${error instanceof Error ? error.message : String(error)} Select the current existing entrypoint with inspect_project_target. This is not evidence that verification passed.` };
  }
}

/** Task entrypoints and manifests establish the target. User prose and model
 * names never turn a native application into browser-model work. */
export async function inspectProjectTarget(root: string, entryPoint?: string): Promise<ProjectVerificationTarget> {
  const files = [...new Set([...(entryPoint ? [entryPoint] : []), 'package.json', 'pyproject.toml', 'requirements.txt', 'index.html', 'main.py'])];
  const observations: { path: string; hash: string; content: string }[] = [];
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new ToolFailure('PROJECT_TARGET_PATH', 'Use a project-relative entrypoint.');
    try {
      const filename = await fs.realpath(path.join(root, relative));
      const local = path.relative(root, filename);
      if (path.isAbsolute(local) || local === '..' || local.startsWith(`..${path.sep}`)) throw new ToolFailure('PROJECT_TARGET_PATH', 'Entrypoint resolves outside the project.');
      if (!(await fs.stat(filename)).isFile() || (await fs.stat(filename)).size > 512000) continue;
      const content = await fs.readFile(filename, 'utf8');
      observations.push({ path: relative, hash: createHash('sha256').update(content).digest('hex'), content });
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const selected = entryPoint ? observations.find(item => item.path === entryPoint) : undefined;
  if (entryPoint && !selected) throw new ToolFailure('PROJECT_TARGET_MISSING', 'Read an existing task entrypoint before selecting its verification target.');
  const browserRuntime = /@mlc-ai\/web-llm|onnxruntime-web|@huggingface\/transformers|@xenova\/transformers|webllm/i;
  const web = observations.filter(item => /\.(html?|jsx?|tsx?)$/i.test(item.path));
  const manifest = observations.find(item => item.path === 'package.json');
  let browserDependency = false;
  if (manifest) {
    try { const json = JSON.parse(manifest.content); browserDependency = Object.keys({ ...json.dependencies, ...json.devDependencies }).some(name => /^(?:@mlc-ai\/web-llm|onnxruntime-web|@huggingface\/transformers|@xenova\/transformers)$/.test(name)); }
    catch { /* Invalid manifest is not evidence of a browser runtime. */ }
  }
  const nativeEntrypoint = selected && /\.(?:py|cs|csproj|java|go|rs)$/i.test(selected.path);
  const browser = !nativeEntrypoint && (web.some(item => browserRuntime.test(item.content)) || Boolean(web.length && browserDependency));
  return { kind: browser ? 'browser_model' : observations.length ? 'general' : 'unknown',
    ...(entryPoint ? { entryPoint } : {}),
    sources: observations.map(({ path, hash }) => ({ path, hash })),
    reason: browser ? 'A web entrypoint and browser inference runtime were inspected.' : nativeEntrypoint ? `Native task entrypoint ${selected!.path}.` : observations.length ? 'Inspected project files do not establish browser-side model inference.' : 'No supported project manifest or entrypoint was found; inspect an explicit task entrypoint.' };
}
