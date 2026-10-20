import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatPlugins } from './chat-plugins';
import { ChatApprovals } from './chat-approvals';
import { WebPolicy } from './web-policy';
import { pluginSearchQueries } from './plugin-search';

let root: string;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });
function fixture(reply: (url: URL) => unknown) {
  root = mkdtempSync(path.join(os.tmpdir(), 'mercury-discovery-'));
  const policy = new WebPolicy();
  const json = vi.spyOn(policy, 'json').mockImplementation(async url => reply(new URL(url)));
  const approvals = new ChatApprovals(() => {});
  return { plugins: new ChatPlugins(root, process.cwd(), policy, approvals), json, approvals };
}
const listing = (name: string, configured = true) => ({ server: { name, version: '1.0.0', description: 'Framework documentation or hosting integration', packages: configured ? [{ registryType: 'npm', identifier: '@fixture/server', version: '1.0.0', transport: { type: 'stdio' } }] : [{ registryType: 'pypi', identifier: 'requires-setup', version: '1.0.0' }] } });

it('expands website/deployment/UI requests and extracts service domains within a bounded query budget', () => {
  const terms = pluginSearchQueries('web dev, deployment, or UI frameworks');
  expect(terms).toEqual(expect.arrayContaining(['context7', 'shadcn', 'react', 'vercel', 'cloudflare', 'netlify']));
  expect(terms.length).toBeLessThanOrEqual(12);
  expect(pluginSearchQueries('Find plugins for https://www.github.com/repo')).toContain('github');
  expect(pluginSearchQueries('cloudflare')).toEqual(['cloudflare']);
});

it('finds category aliases, follows opaque cursors, deduplicates, and retains setup-required listings without executing', async () => {
  const f = fixture(url => {
    const term = url.searchParams.get('search');
    if (term === 'context7') return { servers: [listing('docs/context7')], metadata: { nextCursor: 'opaque&next=2' } };
    if (term === 'vercel') return { servers: [listing('deploy/vercel', false), listing('docs/context7'), { ...listing('deleted/vercel'), _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } }] };
    return { servers: [] };
  });
  const result: any = await f.plugins.discover('chat', 'web dev, deployment, or UI frameworks', new AbortController().signal);
  expect(result.status).toBe('found'); expect(result.totalServersFound).toBe(2); expect(result.matches).toHaveLength(2);
  expect(result.matches.find((match: any) => match.name === 'docs/context7').candidateId).toBeDefined();
  expect(result.matches.find((match: any) => match.name === 'deploy/vercel').installable).toBe(false);
  expect(f.json.mock.calls.some(([url]) => new URL(url).searchParams.get('cursor') === 'opaque&next=2')).toBe(true);
  expect(result.resultsTruncated).toBe(true); // The server kept returning a cursor.
  expect(f.approvals.snapshot()).toEqual([]); expect(await f.plugins.installed()).toEqual([]);
});

it('reports partial network and malformed-response failures rather than claiming there are no plugins', async () => {
  const f = fixture(url => {
    if (url.searchParams.get('search') === 'react') throw new Error('HTTP 503');
    if (url.searchParams.get('search') === 'shadcn') return { unexpected: true };
    return { servers: [] };
  });
  const result = await f.plugins.discover('chat', 'website UI', new AbortController().signal);
  expect(result.status).toBe('partial'); expect(result.searches.filter(item => item.error)).toHaveLength(2);
  expect(result.coverage).toContain('not an exhaustive search'); expect(result.matches).toEqual([]);
});

it('distinguishes a registry outage from a successful empty search', async () => {
  const f = fixture(() => { throw new Error('Offline'); });
  const result = await f.plugins.discover('chat', 'unknown-service', new AbortController().signal);
  expect(result.status).toBe('unavailable'); expect(result.searches[0].error).toContain('Offline');
});

it('propagates Stop instead of converting cancellation into no matches', async () => {
  const controller = new AbortController();
  const f = fixture(() => { controller.abort(new Error('Stopped')); throw controller.signal.reason; });
  await expect(f.plugins.discover('chat', 'website', controller.signal)).rejects.toThrow('Stopped');
});
it('keeps successful first-page results when the next page fails', async () => {
  const f = fixture(url => {
    if (url.searchParams.has('cursor')) throw new Error('Later page unavailable');
    return { servers: [listing('docs/context7')], metadata: { nextCursor: 'next' } };
  });
  const result = await f.plugins.discover('chat', 'context7', new AbortController().signal);
  expect(result.status).toBe('partial'); expect(result.matches).toHaveLength(1); expect(result.searches[0].pages).toBe(1);
});
