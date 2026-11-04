import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace, hash } from './workspace';
import { diagnosePatchMismatch } from './workspace-patch-diagnostics';

async function withSource(source: string, check: (workspace: Workspace, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mercury-patch-diagnostics-'));
  try {
    await fs.writeFile(path.join(root, 'note.txt'), source);
    await check(new Workspace(root), root);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

it('patches a unique exact logical range while preserving surrounding CRLF bytes', async () => {
  const source = 'before\r\n  old\r\n  middle\r\nafter\r\n';
  await withSource(source, async (workspace, root) => {
    const result = await workspace.patch('note.txt', hash(source)!, '  old\n  middle', '  new\n  result');
    const expected = 'before\r\n  new\r\n  result\r\nafter\r\n';
    expect(result).toMatchObject({ path: 'note.txt', before: source, after: expected });
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe(expected);
  });
});

it.each([
  { label: 'typography', source: 'heading\nIt’s saved', search: "It's saved", details: { reason: 'TYPOGRAPHIC_QUOTES', sourceLine: 2, sourceExcerpt: 'It’s saved' } },
  { label: 'escaped backslashes', source: "heading\njoin('\\n')", search: "join('\\\\n')", details: { reason: 'OVER_ESCAPED_BACKSLASHES', sourceLine: 2, sourceExcerpt: "join('\\n')" } },
  { label: 'indentation', source: 'heading\n    first\n\tsecond\nend', search: '  first\n  second', details: { reason: 'LINE_INDENTATION', sourceLine: 2, sourceExcerpt: '    first\n\tsecond', sourceLeadingWhitespace: 4, searchLeadingWhitespace: 2 } },
  { label: 'ambiguous exact matches', source: 'old\nold', search: 'old', details: {} },
  { label: 'empty anchor', source: 'old', search: '', details: {} },
  { label: 'unrelated text', source: 'old', search: 'missing', details: {} },
  { label: 'ambiguous typography equivalents', source: 'It’s saved\nIt’s saved', search: "It's saved", details: {} },
])('diagnoses $label without editing any bytes', async ({ source, search, details }) => {
  await withSource(source, async (workspace, root) => {
    try {
      await workspace.patch('note.txt', hash(source)!, search, 'replacement');
      throw new Error('Expected patch rejection.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PATCH_NO_MATCH', details: { sourceRevision: hash(source), target: 'note.txt', ...details } });
      expect((error as { details: unknown }).details).toEqual({ sourceRevision: hash(source), target: 'note.txt', ...details });
    }
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe(source);
  });
});

it('rejects stale source before attempting mismatch diagnostics', async () => {
  await withSource('It’s saved', async (workspace, root) => {
    await expect(workspace.patch('note.txt', hash('older')!, "It's saved", 'new')).rejects.toMatchObject({ code: 'STALE_REVISION', details: { sourceRevision: hash('It’s saved'), target: 'note.txt' } });
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('It’s saved');
  });
});

it('keeps diagnostic precedence and rejects ambiguous near-matches', () => {
  // Quote normalization is checked before indentation, while source characters
  // and the original search length remain the diagnostic excerpt contract.
  expect(diagnosePatchMismatch('  It’s saved', "  It's saved")).toEqual({ reason: 'TYPOGRAPHIC_QUOTES', sourceLine: 1, sourceExcerpt: '  It’s saved' });
  expect(diagnosePatchMismatch('  value\n    value', ' value')).toEqual({});
  expect(diagnosePatchMismatch('a\\b\na\\b', 'a\\\\b')).toEqual({});
  expect(diagnosePatchMismatch('anything', '')).toEqual({});
});

it('bounds source excerpts without modifying input text', () => {
  const source = '“' + 'x'.repeat(2100) + '”';
  const search = '"' + 'x'.repeat(2100) + '"';
  expect(diagnosePatchMismatch(source, search)).toEqual({ reason: 'TYPOGRAPHIC_QUOTES', sourceLine: 1, sourceExcerpt: source.slice(0, 2000) });
  expect(source).toBe('“' + 'x'.repeat(2100) + '”');
});
