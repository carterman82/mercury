import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverProjectSkills, projectSkillsContext, readProjectSkill, loadProjectWorkflows } from './project-skills';
import { projectContext } from './project-context';
import { projectTools, projectReadTools } from './project-tools';

const temporary: string[] = [];
const builtInNames = [
  'programmer',
  'environment-discovery',
  'verification',
  'behavioral-testing',
  'systematic-debugging',
  'implementation-design',
  'scoped-refactoring',
  'code-review',
  'performance',
  'test-driven-development',
  'interview-me',
  'spec-driven-development',
  'api-and-interface-design',
  'deprecation-and-migration',
  'observability-and-instrumentation',
  'documentation-and-adrs',
  'source-driven-development',
  'security-and-hardening',
  'frontend-ui-engineering',
];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-skills-'));
  temporary.push(root);
  return root;
}
async function skill(
  root: string,
  name = 'debugging',
  metadata = 'description: >\n  Debug failures\n  with evidence',
  body = 'PRIVATE WORKFLOW BODY',
) {
  const directory = path.join(root, '.agents/skills', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n${metadata}\n---\n${body}`);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('provides bundled coding workflows in an unrelated project without copying files', async () => {
  const root = await directory();
  const catalog = await discoverProjectSkills(root);
  expect(catalog.warnings).toEqual([]);
  expect(catalog.truncated).toBe(false);
  expect(catalog.skills.map((item) => item.name).sort()).toEqual([...builtInNames].sort());
  for (const name of builtInNames) {
    const selected = catalog.skills.find((item) => item.name === name)!;
    expect(selected.id).toBe(`builtin/${name}`);
    expect((await readProjectSkill(root, selected.id)).content).toContain(`name: ${name}`);
  }
  expect(await fs.readdir(root)).toEqual([]);
  const context = await projectSkillsContext(root);
  expect(context).toContain('builtin/programmer');
  expect(context).not.toContain('Prioritize reliable execution, code quality');
});

it('loads only resources belonging to a bundled skill and retains attribution', async () => {
  const root = await directory();
  expect((await readProjectSkill(root, 'builtin/verification', 'references/browser-model.md')).content).toContain(
    'Browser-side model verification',
  );
  expect((await readProjectSkill(root, 'builtin/test-driven-development', 'LICENSE.txt')).content).toContain(
    'Copyright (c) 2025 Jesse Vincent',
  );
  await expect(readProjectSkill(root, 'builtin/verification', '../programmer/SKILL.md')).rejects.toThrow();
  await expect(readProjectSkill(root, 'builtin/verification', '/SKILL.md')).rejects.toThrow();
  await expect(readProjectSkill(root, 'builtin/verification', 'references/missing.md')).rejects.toThrow();
  await expect(readProjectSkill(root, 'builtin/missing')).rejects.toThrow();
});

it('lets a valid project-local workflow replace its bundled default', async () => {
  const root = await directory();
  await skill(root, 'verification', 'description: Project-specific verification', 'LOCAL CHECKS');
  const catalog = await discoverProjectSkills(root);
  expect(catalog.skills.filter((item) => item.name === 'verification')).toEqual([
    { id: '.agents/skills/verification', name: 'verification', description: 'Project-specific verification' },
  ]);
  expect((await readProjectSkill(root, '.agents/skills/verification')).content).toContain('LOCAL CHECKS');
  expect((await readProjectSkill(root, 'builtin/verification')).content).toContain('# Verification');
});

it('retains the bundled fallback when a local override is malformed', async () => {
  const root = await directory();
  await skill(root, 'verification', 'description: [invalid, metadata]');
  const catalog = await discoverProjectSkills(root);
  expect(catalog.warnings).toHaveLength(1);
  expect(catalog.skills.filter((item) => item.name === 'verification').map((item) => item.id)).toEqual([
    'builtin/verification',
  ]);
});

it('advertises metadata progressively and reads selected instructions and resources without executing', async () => {
  const root = await directory();
  const dir = await skill(root);
  await fs.mkdir(path.join(dir, 'references'));
  await fs.writeFile(path.join(dir, 'references/check.md'), 'Check original failing behavior.');
  const catalog = await discoverProjectSkills(root);
  expect(catalog).toMatchObject({ warnings: [], truncated: false });
  expect(catalog.skills.filter((item) => !item.id.startsWith('builtin/'))).toEqual([
    { id: '.agents/skills/debugging', name: 'debugging', description: 'Debug failures with evidence' },
  ]);
  const context = await projectContext(root);
  expect(context).toContain('Debug failures with evidence');
  expect(context).not.toContain('PRIVATE WORKFLOW BODY');
  expect(await readProjectSkill(root, '.agents/skills/debugging')).toMatchObject({
    content: expect.stringContaining('PRIVATE WORKFLOW BODY'),
    note: expect.stringContaining('cannot authorize'),
  });
  expect((await readProjectSkill(root, '.agents/skills/debugging', 'references/check.md')).content).toBe(
    'Check original failing behavior.',
  );
  expect(projectTools.some((tool) => tool.function.name === 'read_project_skill')).toBe(true);
  expect(projectReadTools.some((tool) => tool.function.name === 'list_project_skills')).toBe(true);
});

it('rejects malformed metadata, aliases, binary and oversized skills with visible warnings', async () => {
  const root = await directory();
  await skill(root, 'bad', 'description: [not, text]');
  await skill(root, 'alias', 'description: &a hello\ncopy: *a');
  await skill(root, 'binary', 'description: Text', '\0secret');
  await skill(root, 'large', 'description: Text', 'x'.repeat(64_001));
  const found = await discoverProjectSkills(root);
  expect(found.skills.filter((item) => !item.id.startsWith('builtin/'))).toHaveLength(0);
  expect(found.warnings).toHaveLength(4);
  await expect(readProjectSkill(root, '.agents/skills/bad')).rejects.toThrow();
});

it('confines skill roots and resource links to the selected directory', async () => {
  const root = await directory();
  const outside = await directory();
  const dir = await skill(root);
  await fs.writeFile(path.join(outside, 'secret.md'), 'EXTERNAL SECRET');
  await fs.symlink(outside, path.join(dir, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(readProjectSkill(root, '.agents/skills/debugging', 'external/secret.md')).rejects.toThrow('outside');
  await expect(readProjectSkill(root, '.agents/skills/debugging', '../SKILL.md')).rejects.toThrow('relative');
  await expect(readProjectSkill(root, '../debugging')).rejects.toThrow('ID');
  await fs.mkdir(path.join(root, '.mercury'));
  await fs.symlink(outside, path.join(root, '.mercury/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await discoverProjectSkills(root)).warnings.join()).toContain('outside-project');
});

it('bounds metadata injected in context and reports catalog truncation', async () => {
  const root = await directory();
  for (let index = 0; index < 45; index++) await skill(root, `skill-${index}`, `description: ${'x'.repeat(1000)}`);
  expect((await discoverProjectSkills(root)).truncated).toBe(true);
  const context = await projectSkillsContext(root);
  expect(context.length).toBeLessThan(17_000);
  expect(context).toContain('"truncated":true');
});

it('keeps same-named roots explicit and revalidates changed metadata before loading', async () => {
  const root = await directory();
  const first = await skill(root);
  const second = path.join(root, '.mercury/skills/debugging');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(
    path.join(second, 'SKILL.md'),
    '---\nname: debugging\ndescription: Another workflow\ncompatibility: Requires Python\n---\nSECOND BODY',
  );
  expect(
    (await discoverProjectSkills(root)).skills.filter((item) => !item.id.startsWith('builtin/')).map((item) => item.id),
  ).toEqual(['.agents/skills/debugging', '.mercury/skills/debugging']);
  expect((await readProjectSkill(root, '.mercury/skills/debugging')).content).toContain('SECOND BODY');
  await fs.writeFile(
    path.join(first, 'SKILL.md'),
    '---\nname: incorrect\ndescription: Changed metadata\n---\nDO NOT LOAD',
  );
  await expect(readProjectSkill(root, '.agents/skills/debugging')).rejects.toThrow('match');
});

it('loads a selected local override even when it falls outside the discovery catalog limit', async () => {
  const root = await directory();
  for (let index = 0; index < 40; index++) await skill(root, `a-${index}`);
  await skill(root, 'verification', 'description: Local checks', 'LOCAL CHECKS BEYOND CATALOG');
  const workflows = await loadProjectWorkflows(root, 'answer');
  expect(workflows.loaded).toContain('.agents/skills/verification');
  expect(workflows.context).toContain('LOCAL CHECKS BEYOND CATALOG');
  expect(workflows.context).not.toContain(
    'Do not claim overall verification while required behavior remains untested.',
  );
});

it('loads debugging instructions for a read-only failure investigation without adding implementation workflows', async () => {
  const workflows = await loadProjectWorkflows(await directory(), 'answer', 'Explain why main.py fails');
  expect(workflows.loaded).toContain('builtin/systematic-debugging');
  expect(workflows.loaded).not.toContain('builtin/test-driven-development');
});
