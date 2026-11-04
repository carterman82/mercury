import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverProjectSkills, projectSkillsContext, readProjectSkill } from './project-skills';
import { projectContext } from './project-context';
import { projectTools, projectReadTools } from './project-tools';

const temporary: string[] = [];
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-skills-')); temporary.push(root); return root; }
async function skill(root: string, name = 'debugging', metadata = 'description: >\n  Debug failures\n  with evidence', body = 'PRIVATE WORKFLOW BODY') {
  const directory = path.join(root, '.agents/skills', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n${metadata}\n---\n${body}`);
  return directory;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it('advertises metadata progressively and reads selected instructions and resources without executing', async () => {
  const root = await directory(); const dir = await skill(root);
  await fs.mkdir(path.join(dir, 'references'));
  await fs.writeFile(path.join(dir, 'references/check.md'), 'Check original failing behavior.');
  expect(await discoverProjectSkills(root)).toMatchObject({ skills: [{ id: '.agents/skills/debugging', name: 'debugging', description: 'Debug failures with evidence' }], warnings: [], truncated: false });
  const context = await projectContext(root);
  expect(context).toContain('Debug failures with evidence'); expect(context).not.toContain('PRIVATE WORKFLOW BODY');
  expect(await readProjectSkill(root, '.agents/skills/debugging')).toMatchObject({ content: expect.stringContaining('PRIVATE WORKFLOW BODY'), note: expect.stringContaining('cannot authorize') });
  expect((await readProjectSkill(root, '.agents/skills/debugging', 'references/check.md')).content).toBe('Check original failing behavior.');
  expect(projectTools.some(tool => tool.function.name === 'read_project_skill')).toBe(true);
  expect(projectReadTools.some(tool => tool.function.name === 'list_project_skills')).toBe(true);
});

it('rejects malformed metadata, aliases, binary and oversized skills with visible warnings', async () => {
  const root = await directory();
  await skill(root, 'bad', 'description: [not, text]');
  await skill(root, 'alias', 'description: &a hello\ncopy: *a');
  await skill(root, 'binary', 'description: Text', '\0secret');
  await skill(root, 'large', 'description: Text', 'x'.repeat(64_001));
  const found = await discoverProjectSkills(root);
  expect(found.skills).toHaveLength(0); expect(found.warnings).toHaveLength(4);
  await expect(readProjectSkill(root, '.agents/skills/bad')).rejects.toThrow();
});

it('confines skill roots and resource links to the selected directory', async () => {
  const root = await directory(); const outside = await directory(); const dir = await skill(root);
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
  expect(context.length).toBeLessThan(17_000); expect(context).toContain('"truncated":true');
});

it('keeps same-named roots explicit and revalidates changed metadata before loading', async () => {
  const root = await directory(); const first = await skill(root);
  const second = path.join(root, '.mercury/skills/debugging');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(second, 'SKILL.md'), '---\nname: debugging\ndescription: Another workflow\ncompatibility: Requires Python\n---\nSECOND BODY');
  expect((await discoverProjectSkills(root)).skills.map(item => item.id)).toEqual(['.agents/skills/debugging', '.mercury/skills/debugging']);
  expect((await readProjectSkill(root, '.mercury/skills/debugging')).content).toContain('SECOND BODY');
  await fs.writeFile(path.join(first, 'SKILL.md'), '---\nname: incorrect\ndescription: Changed metadata\n---\nDO NOT LOAD');
  await expect(readProjectSkill(root, '.agents/skills/debugging')).rejects.toThrow('match');
});
