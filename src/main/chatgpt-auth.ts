import { createHash, randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
interface Credentials { clientId: string; subject: string; email?: string; access_token: string; refresh_token?: string; id_token?: string; scope: string; expiresAt: number; }

export function authFailure(code?: string, requestId?: string, status?: number): Error {
  const safeCode = code && /^[a-zA-Z0-9_.-]{1,120}$/.test(code) ? code : undefined;
  const safeId = requestId && /^[a-zA-Z0-9_-]{1,150}$/.test(requestId) ? requestId : undefined;
  const message = safeCode === '3p_delegated_access_policy_denied'
    ? 'OpenAI denied delegated access for this sign-in. Mercury cannot override this restriction. Your account, workspace, or this integration may not be eligible. You can explicitly connect an OpenAI API key instead (separate API billing).'
    : safeCode === 'access_denied'
      ? 'ChatGPT sign-in was declined or blocked. If the browser shows a policy restriction, use an OpenAI API key instead (separate API billing), or contact OpenAI support.'
      : 'ChatGPT authentication failed. Check the browser for restrictions, or explicitly connect an OpenAI API key instead (separate API billing).';
  return new Error(`${message}${status ? ` HTTP ${status}.` : ''}${safeCode ? ` Error code: ${safeCode}.` : ''}${safeId ? ` Request ID: ${safeId}.` : ''}`);
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as any;
    throw authFailure(data.error?.code ?? data.error_code ?? (typeof data.error === 'string' ? data.error : undefined), response.headers.get('x-request-id') ?? data.request_id, response.status);
  }
  return response.json();
}

export async function validateIdentity(token: string, clientId: string, nonce: string): Promise<any> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid ChatGPT identity token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('Unsupported ChatGPT identity signature.');
  const metadata = await json(`${issuer}/.well-known/openid-configuration`);
  const jwks = new URL(metadata.jwks_uri);
  if (metadata.issuer !== issuer || jwks.origin !== issuer) throw new Error('Invalid ChatGPT identity configuration.');
  const keys = await json(jwks.toString());
  const key = keys.keys.find((item: any) => item.kid === header.kid && item.kty === 'RSA');
  if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid ChatGPT identity signature.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid ChatGPT account identity.');
  return claims;
}

export class ChatGPTAuth {
  private pending = false;
  private cancelPending?: () => void;
  private refreshes = new Map<string, Promise<string>>();
  constructor(private read: (id: string) => string | undefined, private write: (id: string, value: string | null) => void, private openBrowser: (url: string) => Promise<void>) {}

  cancelSignIn(): void { this.cancelPending?.(); }

  async signIn(accountId?: string): Promise<{ id: string; label: string }> {
    if (this.pending) throw new Error('ChatGPT sign-in is already open in your browser.');
    const previous: Credentials | undefined = accountId && this.read(accountId) ? JSON.parse(this.read(accountId)!) : undefined;
    const registered = accountId ? this.read(`${accountId}-registration`) : undefined;
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const hostId = this.read('chatgpt-host') ?? `urn:uuid:${randomUUID()}`;
    this.write('chatgpt-host', hostId);
    this.pending = true;
    let resolve!: (url: URL) => void;
    let reject!: (error: Error) => void;
    const callback = new Promise<URL>((yes, no) => { resolve = yes; reject = no; });
    this.cancelPending = () => reject(new Error('ChatGPT sign-in cancelled. You can connect an OpenAI API key instead (separate API billing).'));
    // Browser opening may fail before we start awaiting the callback.
    void callback.catch(() => {});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid sign-in callback.'); return; }
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Return to Mercury to finish connecting your ChatGPT account.');
      resolve(url);
    });
    const timer = setTimeout(() => reject(new Error('ChatGPT sign-in did not return to Mercury. If the browser shows 3p_delegated_access_policy_denied, OpenAI blocked delegated access; Mercury cannot override it. You can connect an OpenAI API key instead (separate API billing).')), 180_000);
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      const port = (server.address() as { port: number }).port;
      const redirect = `http://127.0.0.1:${port}/auth/callback`;
      const authorize = new URL(`${issuer}/api/accounts/authorize`);
      const client = previous?.clientId ?? registered;
      authorize.search = new URLSearchParams({ client_id: client ?? 'dynamic_agent_client', ...(!client ? { agent_name_hint: 'Mercury' } : {}), ...(previous?.id_token ? { id_token_hint: previous.id_token } : {}), ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      await this.openBrowser(authorize.toString());
      const result = await callback;
      if (result.searchParams.has('error') || result.searchParams.has('error_code')) throw authFailure(result.searchParams.get('error_code') ?? result.searchParams.get('error') ?? undefined, result.searchParams.get('request_id') ?? undefined);
      const clientId = result.searchParams.get('client_id') ?? client;
      if (client && clientId !== client) throw new Error('ChatGPT returned a different account registration.');
      const code = result.searchParams.get('code');
      if (!clientId || clientId === 'dynamic_agent_client' || !code) throw new Error('ChatGPT registration was incomplete.');
      const id = `chatgpt-${clientId}`;
      this.write(`${id}-registration`, clientId);
      const data = await json(`${issuer}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource }) });
      const claims = await validateIdentity(data.id_token, clientId, nonce);
      if (previous && claims.sub !== previous.subject) throw new Error('ChatGPT returned a different account. Add it as a new account instead.');
      if (!String(data.scope).split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage was not enabled. Reconnect and grant access.');
      if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('ChatGPT did not return usable credentials.');
      this.write(id, JSON.stringify({ ...data, clientId, subject: claims.sub, email: claims.email, expiresAt: Date.now() + data.expires_in * 1000 }));
      return { id, label: `ChatGPT · ${claims.email ?? 'Connected account'}` };
    } finally { clearTimeout(timer); server.close(); server.closeAllConnections(); this.cancelPending = undefined; this.pending = false; }
  }

  async token(id: string): Promise<string> {
    const raw = this.read(id);
    if (!raw) throw new Error('Connect your ChatGPT account in Model settings.');
    const credentials: Credentials = JSON.parse(raw);
    if (!credentials.scope.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('Reconnect ChatGPT and enable plan usage.');
    if (credentials.expiresAt > Date.now() + 60_000) return credentials.access_token;
    const pending = this.refreshes.get(id);
    if (pending) return pending;
    const refresh = (async () => {
      if (!credentials.refresh_token) throw new Error('Reconnect your ChatGPT account in Model settings.');
      const data = await json(`${issuer}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.clientId, refresh_token: credentials.refresh_token, resource }) });
      if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Reconnect your ChatGPT account in Model settings.');
      if (!String(data.scope ?? credentials.scope).split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('Reconnect ChatGPT and enable plan usage.');
      // Do not resurrect a connection removed while its refresh was in flight.
      if (this.read(id) !== raw) throw new Error('ChatGPT connection changed. Try again.');
      this.write(id, JSON.stringify({ ...credentials, ...data, expiresAt: Date.now() + data.expires_in * 1000 }));
      return data.access_token as string;
    })();
    this.refreshes.set(id, refresh);
    try { return await refresh; } finally { this.refreshes.delete(id); }
  }
}
