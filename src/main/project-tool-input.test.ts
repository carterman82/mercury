import { expect, it } from 'vitest';
import { normalizeProjectToolInput } from './project-tool-input';

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
