import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { authFailure, ChatGPTAuth, validateIdentity } from './chatgpt-auth';

afterEach(() => vi.unstubAllGlobals());
const credentials = () => ({ clientId: 'issued-client', subject: 'user-1', access_token: 'expired', refresh_token: 'refresh-old', scope: 'chatgpt.tokens.use.direct', expiresAt: 0 });

describe('ChatGPT account authentication', () => {
  it('explains policy denials and preserves the code and request ID', async () => {
    const requestId = '066edb24-0650-46a7-9758-096b413cfac6';
    const error = authFailure('3p_delegated_access_policy_denied', requestId, 403);
    expect(error.message).toContain('cannot override');
    expect(error.message).toContain('separate API billing');
    expect(error.message).toContain(requestId);
    expect(error.message).toContain('3p_delegated_access_policy_denied');
    const auth = new ChatGPTAuth(() => JSON.stringify(credentials()), () => {}, async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error_code: '3p_delegated_access_policy_denied', request_id: requestId }), { status: 403 })));
    await expect(auth.token('account')).rejects.toThrow(requestId);
  });

  it('cancels a browser sign-in without saving credentials and allows another attempt', async () => {
    const secrets = new Map<string, string>();
    const auth: ChatGPTAuth = new ChatGPTAuth(id => secrets.get(id), (id, value) => { if (value) secrets.set(id, value); }, async (): Promise<void> => { auth.cancelSignIn(); });
    await expect(auth.signIn()).rejects.toThrow('cancelled');
    await expect(auth.signIn()).rejects.toThrow('cancelled');
    expect([...secrets.keys()]).toEqual(['chatgpt-host']);
  });

  it('verifies signatures, audience, expiration, and nonce before trusting identity', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('openid-configuration') ? { issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' } : { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }] }))));
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'client', sub: 'user', exp: Date.now() / 1000 + 3600, nonce: 'correct' })).toString('base64url');
    const token = `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    expect((await validateIdentity(token, 'client', 'correct')).sub).toBe('user');
    await expect(validateIdentity(token, 'wrong-client', 'correct')).rejects.toThrow('identity');
    await expect(validateIdentity(token, 'client', 'wrong-nonce')).rejects.toThrow('identity');
    await expect(validateIdentity(`${header}.${payload}.invalid`, 'client', 'correct')).rejects.toThrow('signature');
  });

  it('rotates refresh tokens once for concurrent model requests', async () => {
    const secrets = new Map([['account', JSON.stringify(credentials())]]);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-new', expires_in: 3600 })));
    vi.stubGlobal('fetch', fetch);
    const auth = new ChatGPTAuth(id => secrets.get(id), (id, value) => { if (value) secrets.set(id, value); else secrets.delete(id); }, async () => {});
    expect(await Promise.all([auth.token('account'), auth.token('account')])).toEqual(['fresh', 'fresh']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secrets.get('account')!).refresh_token).toBe('refresh-new');
    expect(fetch.mock.calls[0][1].body.get('client_id')).toBe('issued-client');
    expect(await auth.token('account')).toBe('fresh');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not restore accounts disconnected during a refresh', async () => {
    const secrets = new Map([['account', JSON.stringify(credentials())]]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      secrets.delete('account');
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }));
    }));
    const auth = new ChatGPTAuth(id => secrets.get(id), (id, value) => { if (value) secrets.set(id, value); }, async () => {});
    await expect(auth.token('account')).rejects.toThrow('connection changed');
    expect(secrets.has('account')).toBe(false);
  });

  it('starts browser sign-in with loopback, fresh PKCE and state, and closes on denial', async () => {
    const realFetch = globalThis.fetch;
    const secrets = new Map<string, string>();
    let previousState = '';
    const auth = new ChatGPTAuth(id => secrets.get(id), (id, value) => { if (value) secrets.set(id, value); }, async raw => {
      const url = new URL(raw);
      expect(url.origin).toBe('https://auth.openai.com');
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toHaveLength(43);
      expect(url.searchParams.get('state')).not.toBe(previousState);
      previousState = url.searchParams.get('state')!;
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('127.0.0.1');
      callback.search = new URLSearchParams({ state: 'wrong', error: 'access_denied' }).toString();
      expect((await realFetch(callback)).status).toBe(400);
      callback.searchParams.set('state', previousState);
      expect((await realFetch(callback)).status).toBe(200);
    });
    await expect(auth.signIn()).rejects.toThrow('declined');
    const host = secrets.get('chatgpt-host');
    await expect(auth.signIn()).rejects.toThrow('declined');
    expect(secrets.get('chatgpt-host')).toBe(host);
  });
});
