import { afterEach, expect, it, vi } from 'vitest';
import { WebSearch, webTools } from './web-search';
import { WebPolicy } from './web-policy';
import { ChatCapabilities } from './chat-capabilities';
import type { ChatBrowser } from './chat-browser';
import type { ChatPlugins } from './chat-plugins';

const origin = 'http://127.0.0.1:12345', signal = new AbortController().signal;
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const service = () => new WebSearch(new WebPolicy(origin), origin + '/search');
const fixture = '<div class="result results_links"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Official &amp; useful</a></h2><a class="result__snippet">Read <b>the docs</b> &amp; examples.</a></div>';
afterEach(() => vi.unstubAllGlobals());

it('routes structured searches without invoking the browser and decodes source URLs/entities', async () => {
  const fetch = vi.fn().mockResolvedValue(html(fixture + fixture)); vi.stubGlobal('fetch', fetch);
  const browser = { search: vi.fn() } as unknown as ChatBrowser;
  const capabilities = new ChatCapabilities(browser, {} as ChatPlugins, service());
  expect(webTools.map(item => item.function.name)).toEqual(['web_search', 'web_fetch']);
  const result: any = await capabilities.execute('chat', 'web_search', { query: 'C++ & docs', count: 3 }, signal);
  expect(result.status).toBe('found'); expect(result.results).toEqual([{ title: 'Official & useful', url: 'https://example.com/docs', snippet: 'Read the docs & examples.' }]);
  expect(new URL(fetch.mock.calls[0][0]).searchParams.get('q')).toBe('C++ & docs');
  expect(browser.search).not.toHaveBeenCalled();
});

it.each([
  ['<form id="challenge-form">captcha</form>', 'blocked'],
  ['<div class="no-results">No results found</div>', 'not_found'],
  ['<h1>Unexpected markup</h1>', 'unavailable'],
])('reports search challenges, empty pages and unknown responses honestly', async (body, status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html(body)));
  expect(await service().execute('web_search', { query: 'test' }, signal)).toMatchObject({ status, results: [] });
});

it('does not mistake legitimate CAPTCHA search terms or snippets for an access challenge', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html('<title>captcha docs</title><input value="captcha">' + fixture.replace('Read <b>the docs</b>', 'Read the reCAPTCHA docs'))));
  expect(await service().execute('web_search', { query: 'captcha docs' }, signal)).toMatchObject({ status: 'found' });
});

it('extracts static source text, omits scripts/hidden content, resolves links, and pages long articles', async () => {
  const fetch = vi.fn().mockImplementation(async () => html('<title>Source &amp; title</title><nav>Navigation</nav><main><h1>Actual source</h1><script>stolen()</script><span hidden>Hidden secret</span><p>' + 'evidence '.repeat(2000) + '</p><a href="/detail#section">Details</a><a href="javascript:bad()">Bad</a></main>'));
  vi.stubGlobal('fetch', fetch);
  const first: any = await service().execute('web_fetch', { url: origin + '/article' }, signal);
  const next: any = await service().execute('web_fetch', { url: origin + '/article', offset: first.nextOffset }, signal);
  expect(first).toMatchObject({ title: 'Source & title', nextOffset: 12000, links: [{ title: 'Details', url: origin + '/detail' }] });
  expect(first.content).toContain('Actual source'); expect(first.content).not.toMatch(/stolen|Hidden secret|Navigation/);
  expect(next.offset).toBe(12000); expect(next.nextOffset).toBeNull();
});

it('follows bounded redirects while rejecting private destinations before requesting them', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final' } })).mockResolvedValueOnce(html('<main>Final page</main>'));
  vi.stubGlobal('fetch', fetch);
  expect(await service().execute('web_fetch', { url: origin }, signal)).toMatchObject({ url: origin + '/final', content: 'Final page' });
  expect(fetch.mock.calls[0][1].redirect).toBe('manual');
  fetch.mockReset().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
  await expect(service().execute('web_fetch', { url: origin }, signal)).rejects.toThrow('network');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('bounds redirect loops, oversized bodies, unsupported data and HTTP failures', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/loop' } })); vi.stubGlobal('fetch', fetch);
  await expect(service().execute('web_fetch', { url: origin }, signal)).rejects.toThrow('redirect limit');
  expect(fetch).toHaveBeenCalledTimes(6);
  fetch.mockImplementationOnce(async () => html('x'.repeat(2_000_001)));
  await expect(service().execute('web_fetch', { url: origin }, signal)).rejects.toThrow('2 MB');
  fetch.mockImplementationOnce(async () => new Response('binary', { headers: { 'content-type': 'application/pdf' } }));
  await expect(service().execute('web_fetch', { url: origin }, signal)).rejects.toThrow('content type');
  fetch.mockImplementationOnce(async () => html('Rate limited', 429));
  await expect(service().execute('web_search', { query: 'test' }, signal)).rejects.toThrow('HTTP 429');
});

it('rejects invalid arguments and cancellation before accessing the network', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const web = service(), controller = new AbortController(); controller.abort(new Error('Stopped'));
  await expect(web.execute('web_search', { query: 'test' }, controller.signal)).rejects.toThrow('Stopped');
  await expect(web.execute('web_search', { query: ' ' }, signal)).rejects.toThrow();
  await expect(web.execute('web_search', { query: 'test', count: 100 }, signal)).rejects.toThrow();
  await expect(web.execute('web_fetch', { url: 'file:///secret' }, signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('aborts an in-flight HTTP read on Stop', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    controller.abort(new Error('Stopped during request'));
    init.signal.throwIfAborted();
  }));
  await expect(service().execute('web_fetch', { url: origin }, controller.signal)).rejects.toThrow('Stopped during request');
});

it.skipIf(!process.env.MERCURY_LIVE_WEB)('searches the live provider and reads a real official source without a browser', async () => {
  const web = new WebSearch();
  const result = await web.search('TypeScript official documentation', 5, signal);
  expect(result.status).toBe('found');
  expect(result.results.some(item => new URL(item.url).hostname === 'www.typescriptlang.org')).toBe(true);
  const source = await web.read('https://www.typescriptlang.org/docs/', 0, signal);
  expect(source.content).toContain('TypeScript');
  expect(source.content.length).toBeGreaterThan(100);
}, 60_000);
