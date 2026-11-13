import { expect, it } from 'vitest';
import { ProjectReadCache } from './project-read-cache';

const page = (hash: string, content = '1: text') => ({ hash, content, totalLines: 1, startLine: 1, endLine: 1, truncated: false, nextStartLine: null });
it('bounds entries and bytes and evicts the least recently used page', () => {
  const cache = new ProjectReadCache(2, 1000);
  cache.validated('a', page('a')); cache.validated('b', page('b'));
  expect(cache.validated('a', page('a')).readReuse?.kind).toBe('validated-cache');
  cache.validated('c', page('c'));
  expect(cache.validated('b', page('b')).readReuse).toBeUndefined();
  cache.validated('large', page('large', 'x'.repeat(1200)));
  expect(cache.validated('large', page('large', 'x'.repeat(1200))).readReuse).toBeUndefined();
});

it('does not confuse different actual ranges or hashes and retains evidence provenance', () => {
  const cache = new ProjectReadCache();
  cache.validated('a', page('old')); cache.recordEvidence('a', page('old'), 'first');
  expect(cache.validated('a', page('old')).readReuse?.originEvidenceId).toBe('first');
  expect(cache.validated('a', page('new')).readReuse).toBeUndefined();
  expect(cache.validated('a', { ...page('new'), startLine: 2, endLine: 2 }).readReuse).toBeUndefined();
});
