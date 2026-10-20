import { expect, it, vi, afterEach } from 'vitest';
import { WebPolicy, publicAddress } from './web-policy';
afterEach(() => vi.unstubAllGlobals());
it.each(['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.80.53.57', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])('blocks nonpublic IP %s', address => expect(publicAddress(address)).toBe(false));
it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public IP %s', address => expect(publicAddress(address)).toBe(true));
it.each(['file:///C:/secret.txt', 'data:text/html,test', 'javascript:alert(1)', 'http://user:password@example.com', 'http://localhost/', 'http://foo.local/', 'http://127.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/'])('rejects unsafe URL %s', async url => { await expect(new WebPolicy().check(url)).rejects.toThrow(); });
it('only allows the exact injected test origin and refuses redirects at fetch time', async () => {
  const policy = new WebPolicy('http://127.0.0.1:12345');
  expect((await policy.check('http://127.0.0.1:12345/path')).pathname).toBe('/path');
  await expect(policy.check('http://127.0.0.1:12346/path')).rejects.toThrow();
  const fetch = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch', fetch);
  await policy.fetch('http://127.0.0.1:12345/data', { method: 'POST', body: '{}' });
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', method: 'POST', body: '{}' });
});
it('bounds registry responses and preserves HTTP errors', async () => {
  const policy = new WebPolicy('http://127.0.0.1:12345');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('x'.repeat(2_000_001))).mockResolvedValueOnce(new Response('no', { status: 503 })));
  await expect(policy.json('http://127.0.0.1:12345/data', new AbortController().signal)).rejects.toThrow('exceeds 2 MB');
  await expect(policy.json('http://127.0.0.1:12345/data', new AbortController().signal)).rejects.toThrow('HTTP 503');
});
