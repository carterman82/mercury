import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProjectMaps, type ProjectDependencyGraph } from './project-maps';

const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-maps-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function callsBetween(graph: ProjectDependencyGraph, callerFile: string, targetFile: string) {
  const targetIds = new Set(graph.symbols.filter((symbol) => symbol.file === targetFile).map((symbol) => symbol.id));
  return graph.edges.filter(
    (edge) => edge.kind === 'calls' && edge.file === callerFile && edge.to && targetIds.has(edge.to),
  );
}

it('reads existing diagrams without rebuilding or loading an oversized graph', async () => {
  const root = await fixture({
    '.mercury/architecture/system.mmd': 'flowchart LR\nMain --> Storage',
    '.mercury/architecture/generated/methods/test.mmd': 'flowchart LR\nFormula --> Cell',
  });
  const graph = path.join(root, '.mercury/architecture/graph.json');
  await fs.writeFile(graph, 'x'.repeat(33 * 1024 * 1024));
  const maps = new ProjectMaps();
  const before = await fs.stat(graph);
  const names = await maps.existingDiagrams(root);
  expect(names).toEqual(['generated/methods/test.mmd', 'system.mmd']);
  expect((await maps.readDiagram(root, names[0], true)).content).toContain('Formula');
  expect((await fs.stat(graph)).mtimeMs).toBe(before.mtimeMs);
  expect(await fs.readdir(root)).toEqual(['.mercury']);
});

it('does not create diagrams when none exist', async () => {
  const root = await fixture({});
  expect(await new ProjectMaps().existingDiagrams(root)).toEqual([]);
  expect(await fs.readdir(root)).toEqual([]);
});

it('updates only changed source diagrams and preserves unrelated diagram modification times', async () => {
  const root = await fixture({ 'a.ts': 'export function before() { return 1; }', 'b.ts': 'export function untouched() { return 2; }' });
  const maps = new ProjectMaps();
  const graph = await maps.refresh(root);
  const a = graph.files.find(file => file.path === 'a.ts')!;
  const b = graph.files.find(file => file.path === 'b.ts')!;
  const aMap = `.mercury/architecture/generated/methods/${a.id}-000.mmd`;
  const bMap = `.mercury/architecture/generated/methods/${b.id}-000.mmd`;
  const bBefore = await fs.stat(path.join(root, bMap));
  const graphBefore = await fs.stat(path.join(root, '.mercury/architecture/graph.json'));
  await fs.writeFile(path.join(root, 'a.ts'), 'export function after() { return 3; }');
  await maps.updateChanged(root, ['a.ts']);
  expect(await fs.readFile(path.join(root, aMap), 'utf8')).toContain('after');
  expect((await fs.stat(path.join(root, bMap))).mtimeMs).toBe(bBefore.mtimeMs);
  expect((await fs.stat(path.join(root, '.mercury/architecture/graph.json'))).mtimeMs).toBe(graphBefore.mtimeMs);
  await fs.unlink(path.join(root, 'a.ts'));
  await maps.updateChanged(root, ['a.ts']);
  await expect(fs.stat(path.join(root, aMap))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await maps.hasExistingDiagrams(root)).toBe(true);
});

it('uses the TypeScript compiler to resolve cross-file functions and marks member dispatch inferred', async () => {
  const root = await fixture({
    'src/helper.ts':
      'export function add(a: number, b: number) { return a + b; }\nexport class Helper { static calculate() { return add(1, 2); } }',
    'src/main.ts':
      'import { add, Helper } from "./helper";\nexport function run() { return add(2, 3) + Helper.calculate(); }',
    'legacy.js': 'export function plain() { return 1; }',
    'package.json': '{"main":"src/main.ts"}',
  });
  const maps = new ProjectMaps();
  const graph = await maps.refresh(root);
  expect(graph.diagnostics).toEqual([]);
  expect(graph.coverage.parsedFiles).toBe(4);
  expect(
    callsBetween(graph, 'src/main.ts', 'src/helper.ts')
      .map((edge) => edge.confidence)
      .sort(),
  ).toEqual(['confirmed', 'inferred']);
  expect(graph.edges.some((edge) => edge.kind === 'configuration' && edge.confidence === 'inferred')).toBe(true);
  expect(await maps.status(root)).toMatchObject({ available: true, fresh: true });
  expect((await maps.query(root, { query: 'calculate' })).symbols.map((symbol) => symbol.qualifiedName)).toContain(
    'Helper.calculate',
  );
});

it.each([
  [
    'python',
    { 'helper.py': 'def add():\n return 1\n', 'main.py': 'from helper import add\ndef run():\n return add()\n' },
    'main.py',
    'helper.py',
  ],
  [
    'java',
    {
      'demo/Helper.java': 'package demo; public class Helper { public static int add(){return 1;} }',
      'demo/App.java': 'package demo; import demo.Helper; class App { int run(){return Helper.add();} }',
    },
    'demo/App.java',
    'demo/Helper.java',
  ],
  [
    'csharp',
    {
      'Helper.cs': 'namespace Demo { class Helper { public static int Add(){return 1;} } }',
      'App.cs': 'using Demo; namespace Demo { class App { int Run(){return Helper.Add();} } }',
    },
    'App.cs',
    'Helper.cs',
  ],
  [
    'go',
    {
      'go.mod': 'module example\n',
      'helper/helper.go': 'package helper\nfunc Add() int {return 1}\n',
      'main.go': 'package main\nimport "example/helper"\nfunc run(){helper.Add()}\n',
    },
    'main.go',
    'helper/helper.go',
  ],
  [
    'rust',
    { 'src/helper.rs': 'pub fn add() -> i32 {1}', 'src/main.rs': 'use crate::helper::add; fn run(){add();}' },
    'src/main.rs',
    'src/helper.rs',
  ],
  [
    'c',
    {
      'helper.h': 'int add(void);',
      'helper.c': '#include "helper.h"\nint add(void){return 1;}',
      'main.c': '#include "helper.h"\nint run(void){return add();}',
    },
    'main.c',
    'helper.c',
  ],
  [
    'cpp',
    {
      'helper.hpp': 'class Helper { public: static int add(); };',
      'helper.cpp': '#include "helper.hpp"\nint Helper::add(){return 1;}',
      'main.cpp': '#include "helper.hpp"\nint run(){return Helper::add();}',
    },
    'main.cpp',
    'helper.cpp',
  ],
] as const)(
  'parses %s with a packaged WASM grammar and labels cross-file name resolution inferred',
  async (language, files, caller, target) => {
    const root = await fixture(files);
    const maps = new ProjectMaps();
    const graph = await maps.refresh(root);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.coverage.languages).toContain(language);
    expect(callsBetween(graph, caller, target)).toHaveLength(1);
    expect(callsBetween(graph, caller, target)[0].confidence).toBe('inferred');
    expect(
      graph.edges.some((edge) => edge.kind === 'imports' && edge.file === caller && edge.confidence === 'confirmed'),
    ).toBe(true);
  },
);

it('keeps ambiguous overloads, dynamic calls and macros unresolved rather than guessing implementations', async () => {
  const root = await fixture({
    'helper.py': 'def add():\n return 1\ndef add(x):\n return x\n',
    'main.py': 'from helper import add\ndef run(fn):\n add()\n fn()\n',
    'main.rs': 'fn run(){unknown_macro!();}',
  });
  const graph = await new ProjectMaps().refresh(root);
  const ambiguous = graph.edges.find(
    (edge) => edge.file === 'main.py' && edge.kind === 'calls' && edge.label === 'add',
  );
  expect(ambiguous).toMatchObject({ to: null, confidence: 'unresolved' });
  expect(ambiguous?.reason).toContain('Ambiguous');
  expect(graph.edges.find((edge) => edge.file === 'main.rs' && edge.kind === 'calls')).toMatchObject({
    to: null,
    confidence: 'unresolved',
    reason: 'Macro expansion is not executed.',
  });
});

it('preserves architectural explanations and produces deterministic maps, links and stable symbol IDs', async () => {
  const root = await fixture({
    'a.ts': 'export function stable(){return 1;}',
    '.mercury/architecture/system.mmd': 'flowchart LR\n a["Custom architecture"] --> b["Storage"]\n',
  });
  const maps = new ProjectMaps();
  const first = await maps.refresh(root);
  const graphFile = path.join(root, '.mercury/architecture/graph.json');
  const bytes = await fs.readFile(graphFile, 'utf8');
  const second = await new ProjectMaps().refresh(root);
  expect(second).toEqual(first);
  expect(await fs.readFile(graphFile, 'utf8')).toBe(bytes);
  expect((await maps.readDiagram(root, 'system.mmd')).content).toContain('Custom architecture');
  const oldId = first.symbols.find((symbol) => symbol.name === 'stable')!.id;
  await fs.writeFile(path.join(root, 'a.ts'), '\n\nexport function stable(){return 2;}');
  expect((await maps.status(root)).fresh).toBe(false);
  const updated = await maps.refresh(root);
  expect(updated.symbols.find((symbol) => symbol.name === 'stable')!.id).toBe(oldId);
  const index = await fs.readFile(path.join(root, '.mercury/architecture/index.md'), 'utf8');
  for (const diagram of (await maps.status(root)).diagrams) {
    expect(index).toContain(diagram);
    expect((await maps.readDiagram(root, diagram)).content).toContain('flowchart LR');
  }
});

it('updates renamed/deleted sources and removes only obsolete generated diagrams', async () => {
  const root = await fixture({
    'first.py': 'def first():\n return 1\n',
    '.mercury/architecture/notes.md': 'Human notes',
  });
  const maps = new ProjectMaps();
  const original = await maps.refresh(root);
  const obsolete = `generated/methods/${original.files[0].id}-000.mmd`;
  await fs.rename(path.join(root, 'first.py'), path.join(root, 'renamed.py'));
  const renamed = await maps.refresh(root);
  expect(renamed.files.map((file) => file.path)).toEqual(['renamed.py']);
  await expect(fs.stat(path.join(root, '.mercury/architecture', obsolete))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(root, '.mercury/architecture/notes.md'), 'utf8')).toBe('Human notes');
  await fs.unlink(path.join(root, 'renamed.py'));
  expect((await maps.refresh(root)).files).toEqual([]);
});

it('keeps worker analysis in memory and can later persist the same graph without losing source isolation', async () => {
  const root = await fixture({ 'worker.py': 'def worker():\n return 1\n' });
  const maps = new ProjectMaps();
  const graph = await maps.refresh(root, undefined, { persist: false });
  await expect(fs.stat(path.join(root, '.mercury'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await maps.query(root, { query: 'worker' })).symbols).toHaveLength(1);
  expect(await maps.status(root)).toMatchObject({ available: true, fresh: true, persisted: false, diagrams: [] });
  expect(await maps.refresh(root)).toEqual(graph);
  expect(await maps.status(root)).toMatchObject({ available: true, fresh: true, persisted: true });
});

it('detects missing or modified generated files even when source and cached graph are unchanged', async () => {
  const root = await fixture({ 'main.py': 'def main():\n return 1\n' });
  const maps = new ProjectMaps();
  await maps.refresh(root);
  const diagram = (await maps.status(root)).diagrams.find((value) => value.startsWith('generated/'))!;
  await fs.writeFile(path.join(root, '.mercury/architecture', diagram), 'malformed');
  expect((await maps.status(root)).fresh).toBe(false);
  await maps.refresh(root);
  expect((await maps.readDiagram(root, diagram)).content).toContain('flowchart LR');
  await fs.unlink(path.join(root, '.mercury/architecture/index.md'));
  expect((await maps.status(root)).fresh).toBe(false);
  await maps.refresh(root);
  expect((await maps.status(root)).fresh).toBe(true);
});

it('skips source junctions and rejects a linked architecture output directory', async () => {
  const outside = await fixture({ 'secret.py': 'PRIVATE_SOURCE = 1' });
  const root = await fixture({ 'main.ts': 'export const ready = true;' });
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const maps = new ProjectMaps();
  const graph = await maps.refresh(root);
  expect(graph.files.map((file) => file.path)).toEqual(['main.ts']);
  expect(JSON.stringify(graph)).not.toContain('PRIVATE_SOURCE');
  const poisoned = await fixture({ 'main.py': 'def main():\n return 1\n' });
  await fs.mkdir(path.join(poisoned, '.mercury'));
  await fs.symlink(
    outside,
    path.join(poisoned, '.mercury', 'architecture'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(maps.refresh(poisoned)).rejects.toThrow(/cannot follow links/);
  await expect(fs.stat(path.join(outside, 'graph.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(maps.readDiagram(root, '../secret.mmd')).rejects.toThrow(/Invalid/);
});

it('records syntax errors and parser failures without pretending full language coverage', async () => {
  const root = await fixture({
    'broken.py': 'def broken(:\n',
    'broken.ts': 'function broken( {',
    'good.java': 'class Good {}',
  });
  const graph = await new ProjectMaps().refresh(root);
  expect(graph.diagnostics.some((diagnostic) => diagnostic.file === 'broken.py')).toBe(true);
  expect(graph.diagnostics.some((diagnostic) => diagnostic.file === 'broken.ts')).toBe(true);
  const absent = await fixture({ 'main.py': 'def main():\n return 1\n' });
  const incomplete = await new ProjectMaps({ grammarRoot: path.join(absent, 'missing-grammars') }).refresh(absent);
  expect(incomplete.coverage.parsedFiles).toBe(0);
  expect(incomplete.diagnostics[0].message).toContain('Parser unavailable');
  expect((await new ProjectMaps().refresh(absent)).coverage.parsedFiles).toBe(1);
});

it('partitions large call graphs without losing edges and escapes diagram labels', async () => {
  const helper = Array.from(
    { length: 100 },
    (_unused, index) => `export function target${index}(){return ${index};}`,
  ).join('\n');
  const calls = Array.from({ length: 100 }, (_unused, index) => `target${index}()`).join('+');
  const root = await fixture({
    'helper.ts': helper,
    'main.ts': `import {${Array.from({ length: 100 }, (_unused, index) => `target${index}`).join(',')}} from './helper'; export function run(){return ${calls};}`,
  });
  const maps = new ProjectMaps();
  const graph = await maps.refresh(root);
  const status = await maps.status(root);
  const caller = graph.files.find((file) => file.path === 'main.ts')!;
  const diagrams = status.diagrams.filter((file) => file.startsWith(`generated/methods/${caller.id}-`));
  expect(diagrams.length).toBeGreaterThan(1);
  const rendered = (await Promise.all(diagrams.map((file) => maps.readDiagram(root, file))))
    .map((file) => file.content)
    .join('\n');
  for (const dependency of callsBetween(graph, 'main.ts', 'helper.ts'))
    expect(rendered).toContain(`${dependency.from} --> ${dependency.to}`);
  await fs.writeFile(path.join(root, 'strange&name.ts'), 'export function safely(){return 1;}');
  await maps.refresh(root);
  const sourceDiagrams = (await maps.status(root)).diagrams.filter((file) => file.startsWith('generated/files-'));
  expect(
    (await Promise.all(sourceDiagrams.map((file) => maps.readDiagram(root, file))))
      .map((file) => file.content)
      .join('\n'),
  ).toContain('&amp;');
});

it('never evaluates project code and stops a cancelled refresh before writing maps', async () => {
  const root = await fixture({ 'main.js': 'throw new Error("DO NOT EXECUTE"); export function ready(){return 1;}' });
  const maps = new ProjectMaps();
  expect((await maps.refresh(root)).symbols.some((symbol) => symbol.name === 'ready')).toBe(true);
  const cancelled = await fixture({ 'main.py': 'def main():\n return 1\n' });
  const controller = new AbortController();
  controller.abort(new Error('Stopped'));
  await expect(maps.refresh(cancelled, controller.signal)).rejects.toThrow('Stopped');
  await expect(fs.stat(path.join(cancelled, '.mercury'))).rejects.toMatchObject({ code: 'ENOENT' });
});
