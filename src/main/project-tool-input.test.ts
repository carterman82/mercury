import { expect, it } from 'vitest';
import { normalizeProjectToolInput } from './project-tool-input';
import { newHandoff, updateProjectTask } from './project-progress';

it('routes a complete hash supplied in the revision field without overriding a conflicting precondition', () => {
  const revision = 'a'.repeat(64);
  expect(normalizeProjectToolInput('patch_project_file', { path: 'file', revision, oldText: 'a', newText: 'b' })).toEqual({ path: 'file', expectedHash: revision, oldText: 'a', newText: 'b' });
  const conflict = { path: 'file', revision, expectedHash: 'b'.repeat(64) };
  expect(normalizeProjectToolInput('patch_project_file', conflict)).toBe(conflict);
});

it('decodes the exact local-model task-argument wrapper without inventing fields',()=>{
  const raw={requirements:'[{"text":"Test"}],"remaining":"Implement"}'};
  expect(normalizeProjectToolInput('update_project_task',raw)).toEqual({requirements:[{text:'Test'}],remaining:'Implement'});
});
it('leaves ambiguous, malformed, and unrelated tool inputs for strict validation',()=>{
  for(const raw of [{requirements:'[bad'},{requirements:'[]',remaining:'Test'}])expect(normalizeProjectToolInput('update_project_task',raw)).toBe(raw);
  const raw={requirements:'[],"remaining":"Test"}'};
  expect(normalizeProjectToolInput('edit_project_file',raw)).toBe(raw);
});
it('normalizes quoted null only for explicit create-only whole-file writes', () => {
  expect(normalizeProjectToolInput('edit_project_file', { path: 'new.html', expectedHash: 'null', content: 'hello' })).toEqual({ path: 'new.html', expectedHash: null, content: 'hello' });
  expect(normalizeProjectToolInput('edit_project_file', { path: 'new.html', content: 'hello' })).toEqual({ path: 'new.html', expectedHash: null, content: 'hello' });
  for (const raw of [{ path: 'file', expectedHash: '' }, { path: 'file', expectedHash: 'undefined' }, { path: 'file', expectedHash: 'null', revision: 'existing' }])
    expect(normalizeProjectToolInput('edit_project_file', raw)).toBe(raw);
  const patch = { path: 'file', expectedHash: 'null', oldText: 'a', newText: 'b' };
  expect(normalizeProjectToolInput('patch_project_file', patch)).toBe(patch);
});

it('normalizes exact empty create preconditions idempotently without changing the input', () => {
  for (const revision of [undefined, '']) for (const expectedHash of [undefined, 'null', '']) {
    const raw = { path: 'new.txt', content: 'created', revision, expectedHash };
    const normalized = normalizeProjectToolInput('edit_project_file', raw);
    expect(normalized).toEqual({ path: 'new.txt', content: 'created', expectedHash: null });
    expect(normalizeProjectToolInput('edit_project_file', normalized)).toBe(normalized);
    expect(raw).toEqual({ path: 'new.txt', content: 'created', revision, expectedHash });
  }
});

it('does not repair empty preconditions on patches, conflicts, whitespace, or incomplete edits', () => {
  for (const raw of [
    { path: 'file', content: 'text', revision: '', expectedHash: 'a'.repeat(64) },
    { path: 'file', content: 'text', revision: '123E4567-E89B-42D3-A456-426614174000', expectedHash: '' },
    { path: 'file', content: 'text', revision: '', expectedHash: null },
    { path: 'file', content: 'text', revision: ' ', expectedHash: '' },
    { path: 'file', content: 'text', revision: '', expectedHash: ' ' },
    { path: 'file', revision: '', expectedHash: '' },
    { path: 1, content: 'text', revision: '', expectedHash: '' },
  ]) expect(normalizeProjectToolInput('edit_project_file', raw)).toBe(raw);
  const patch = { path: 'file', oldText: 'old', newText: 'new', revision: '', expectedHash: '' };
  expect(normalizeProjectToolInput('patch_project_file', patch)).toBe(patch);
});

const uuid = '123E4567-E89B-42D3-A456-426614174000';
const sha = 'ab'.repeat(32);
it.each(['edit_project_file', 'patch_project_file'])('repairs misplaced revision and hash tokens for %s without altering inputs', name => {
  const fields = name === 'edit_project_file' ? { content: 'full file' } : { oldText: 'old', newText: 'new' };
  for (const [raw, expected] of [
    [{ path: 'file', ...fields, expectedHash: uuid }, { path: 'file', ...fields, revision: uuid }],
    [{ path: 'file', ...fields, revision: sha }, { path: 'file', ...fields, expectedHash: sha }],
  ]) {
    const before = structuredClone(raw);
    const normalized = normalizeProjectToolInput(name, raw);
    expect(normalized).toEqual(expected);
    expect(raw).toEqual(before);
    expect(normalizeProjectToolInput(name, normalized)).toBe(normalized);
  }
});

it.each(['edit_project_file', 'patch_project_file'])('leaves conflicting and malformed preconditions unchanged for %s', name => {
  for (const raw of [
    { path: 'file', expectedHash: uuid, revision: sha },
    { path: 'file', expectedHash: null, revision: sha },
    { path: 'file', expectedHash: '', revision: sha },
    { path: 'file', expectedHash: uuid, revision: null },
    { path: 'file', revision: sha.toUpperCase() },
    { path: 'file', revision: sha.slice(1) },
    { path: 'file', revision: ` ${sha}` },
    { path: 'file', expectedHash: uuid.slice(1) },
    { path: 'file', expectedHash: 'null' },
  ]) expect(normalizeProjectToolInput(name, raw)).toBe(raw);
});

it('keeps unsupported shapes and unrelated tool inputs unchanged', () => {
  for (const name of ['edit_project_file', 'patch_project_file', 'update_project_task']) {
    for (const raw of [null, undefined, false, 7, 'null', [], [{ expectedHash: uuid }]])
      expect(normalizeProjectToolInput(name, raw)).toBe(raw);
  }
  for (const raw of [
    { path: 'file', content: null }, { path: 1, content: 'text' },
    { path: 'file', content: 'text', expectedHash: null },
    { path: 'file', content: 'text', expectedHash: 'NULL' },
    { path: 'file', content: 'text', expectedHash: ' null ' },
    { path: 'file', content: 'text', revision: null },
  ]) expect(normalizeProjectToolInput('edit_project_file', raw)).toBe(raw);
  const patch = { path: 'file', oldText: 'old', newText: 'new' };
  expect(normalizeProjectToolInput('patch_project_file', patch)).toBe(patch);
  const other = { path: 'file', content: 'text', expectedHash: uuid };
  expect(normalizeProjectToolInput('read_project_file', other)).toBe(other);
});

it('is idempotent for create-only edits and decoded task wrappers', () => {
  for (const raw of [{ path: 'new', content: '' }, { path: 'new', content: 'text', expectedHash: 'null' }]) {
    const normalized = normalizeProjectToolInput('edit_project_file', raw);
    expect(normalized).toEqual({ ...raw, expectedHash: null });
    expect(normalizeProjectToolInput('edit_project_file', normalized)).toBe(normalized);
  }
  const raw = { requirements: '  [],"remaining":"Implement"}' };
  const normalized = normalizeProjectToolInput('update_project_task', raw);
  expect(normalized).toEqual({ requirements: [], remaining: 'Implement' });
  expect(normalizeProjectToolInput('update_project_task', normalized)).toBe(normalized);
  expect(raw.requirements).toBe('  [],"remaining":"Implement"}');
});

it('decodes unknown task fields without bypassing strict task validation', () => {
  const handoff = newHandoff(undefined, 'Keep scope');
  const before = structuredClone(handoff);
  for (const requirements of ['[],"remaining":"Implement","unknown":true}', '[]}']) {
    const normalized = normalizeProjectToolInput('update_project_task', { requirements });
    expect(() => updateProjectTask(handoff, normalized, [])).toThrow(expect.objectContaining({ name: 'ZodError' }));
    expect(handoff).toEqual(before);
  }
});
