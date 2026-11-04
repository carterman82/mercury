import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from './workspace';

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-repository-search-'));
  temporary.push(root);
  return { root, workspace: new Workspace(root), write: async (name: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  } };
}

it('honors nested ignore files, negation, hidden source files and private-directory exclusions outside Git', async () => {
  const { write, workspace } = await fixture();
  await write('.gitignore', '*.log\n!keep.log\n');
  await write('skip.log', 'needle'); await write('keep.log', 'needle');
  await write('nested/.gitignore', 'secret.txt\n');
  await write('nested/secret.txt', 'needle'); await write('nested/source.txt', 'needle');
  await write('nested/ignored.log', 'needle');
  await write('.config/app.txt', 'needle'); await write('.mercury/git/config', 'needle');
  await write('.venv-dev/lib/source.txt', 'needle'); await write('node_modules/source.txt', 'needle');
  const files = await workspace.list();
  expect(files).toContain('keep.log'); expect(files).toContain('.config/app.txt');
  for (const name of ['skip.log', 'nested/secret.txt', '.mercury/git/config', '.venv-dev/lib/source.txt', 'node_modules/source.txt']) expect(files).not.toContain(name);
  expect(await workspace.search('needle')).toEqual(['.config/app.txt:1: needle', 'keep.log:1: needle', 'nested/source.txt:1: needle']);
  expect(await workspace.list('nested')).toContain('nested/source.txt');
  expect(await workspace.list('nested')).not.toContain('nested/secret.txt');
  expect(await workspace.list('nested')).not.toContain('nested/ignored.log');
});

it('searches past the old 300-file and eight-directory limits and treats query syntax literally', async () => {
  const { write, workspace } = await fixture();
  await Promise.all(Array.from({ length: 305 }, (_, index) => write(`a/${index}.txt`, 'unrelated')));
  const deep = `${Array.from({ length: 12 }, (_, index) => `d${index}`).join('/')}/source.txt`;
  await write(deep, 'literal --glob [a-z]');
  expect(await workspace.search('--glob [a-z]')).toEqual([`${deep}:1: literal --glob [a-z]`]);
  expect(await workspace.search('does-not-exist')).toEqual([]);
});

it('bounds results explicitly and supports cancellation', async () => {
  const { write, workspace } = await fixture();
  await write('many.txt', 'needle\n'.repeat(60));
  const results = await workspace.search('needle');
  expect(results).toHaveLength(51); expect(results.at(-1)).toContain('truncated after 50');
  expect(await workspace.list('', 1)).toHaveLength(1);
  // Command state snapshots request 100001 entries to detect their 100000-file cap.
  expect(await workspace.list('', 100001)).toEqual(['many.txt']);
  const controller = new AbortController(); controller.abort(new Error('Stopped by user'));
  await expect(workspace.search('needle', controller.signal)).rejects.toThrow('Stopped by user');
  await expect(workspace.list('../')).rejects.toThrow('Invalid workspace path');
});

it('lists large assets for command snapshots while limiting text search file size', async () => {
  const { write, workspace } = await fixture();
  await write('weights.bin', 'needle'.repeat(90000));
  expect(await workspace.list('', 100001)).toContain('weights.bin');
  expect(await workspace.search('needle')).toEqual([]);
});
