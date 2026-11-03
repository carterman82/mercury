import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from './workspace';

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it('hides private Git storage from project file listings and blocks direct metadata edits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-private-git-files-'));
  temporary.push(root);
  await fs.mkdir(path.join(root, '.mercury', 'git'), { recursive: true });
  await fs.writeFile(path.join(root, '.mercury', 'git', 'config'), '[core]');
  await fs.writeFile(path.join(root, 'app.txt'), 'source');
  const workspace = new Workspace(root);
  expect(await workspace.list()).toEqual(['app.txt']);
  for (const target of ['.git/config', '.GIT/config', '.mercury/git/config', '.MERCURY/GIT/config']) {
    await expect(workspace.edit(target, null, 'overwrite')).rejects.toThrow('Git metadata');
  }
  expect(await fs.readFile(path.join(root, '.mercury', 'git', 'config'), 'utf8')).toBe('[core]');
});
