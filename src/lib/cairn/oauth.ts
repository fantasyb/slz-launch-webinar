/** Local OAuth for a single explicitly selected MCP connection. Uses the SDK's
 * resource validation, discovery, registration and PKCE implementation. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { OAuthTokensSchema, OAuthClientInformationSchema, type OAuthClientInformationMixed, type OAuthClientMetadata, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface OAuthRecord {
  version: 1; serverUrl: string; redirectUrl?: string;
  client?: OAuthClientInformationMixed; tokens?: OAuthTokens;
  expiresAt?: number; checkedAt?: number; toolsCount?: number; discovery?: OAuthDiscoveryState; needsLogin?: boolean;
}
export function oauthUrl(value: string): URL {
  const u = new URL(value);
  if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('OAuth requires HTTPS, or HTTP on a local loopback server.');
  return u;
}
export function oauthFile(stateDir: string, id: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid connection ID.');
  return path.join(stateDir, 'oauth', `${id}.json`);
}
function privateParent(file: string) {
  const dir = path.dirname(file);
  for (let p = dir; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Linked OAuth storage is unsupported.');
    if (p === path.dirname(p)) break;
  }
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('OAuth storage must be a private local directory.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
}
export function readOAuth(file: string, serverUrl: string): OAuthRecord {
  const url = oauthUrl(serverUrl).href;
  if (!fs.existsSync(file)) return { version: 1, serverUrl: url };
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024 * 1024 || (process.platform !== 'win32' && (st.mode & 0o077))) throw new Error('unsafe');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || record.serverUrl !== url) throw new Error('binding');
    if (record.tokens) OAuthTokensSchema.parse(record.tokens);
    if (record.client) OAuthClientInformationSchema.parse(record.client);
    if (record.redirectUrl && !['127.0.0.1', 'localhost', '[::1]'].includes(oauthUrl(record.redirectUrl).hostname)) throw new Error('redirect');
    return record;
  } catch { throw new Error('OAuth credentials are unreadable or belong to another connection. Reconnect through guided setup; no credential contents are printed.'); }
}
function saveOAuth(file: string, record: OAuthRecord) {
  privateParent(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
}
export function forgetOAuth(file: string) {
  // Only remove this connection's credential record, never a caller-supplied tree.
  try { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('unsafe'); fs.unlinkSync(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not remove local OAuth credentials.'); }
}

export function recordConnectionCheck(file: string, serverUrl: string, tools: number) {
  saveOAuth(file, { ...readOAuth(file, serverUrl), checkedAt: Date.now(), toolsCount: tools, needsLogin: false });
}
function acquireLock(file: string): number {
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid)); return fd;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Recover only a lock whose owner is demonstrably gone, never a live login.
    const st = fs.lstatSync(file);
    if (st.isFile() && !st.isSymbolicLink() && st.size < 20) {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (dead) {
          if ((dead as NodeJS.ErrnoException).code === 'ESRCH' && fs.lstatSync(file).ino === st.ino) { fs.unlinkSync(file); return acquireLock(file); }
        }
      }
    }
    throw e;
  }
}

export const oauthFetch: typeof fetch = async (input, init) => {
  oauthUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const response = await fetch(input, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(20_000) });
  if (response.ok) return response;
  // OAuth error descriptions and failed HTTP bodies can echo credentials. Keep
  // protocol error codes and challenge headers, never server-supplied prose.
  let code = 'connection_failed';
  try { const body = await response.json(); if (['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable'].includes(body.error)) code = body.error; } catch { /* opaque failure */ }
  return new Response(JSON.stringify({ error: code }), { status: response.status, headers: { 'content-type': 'application/json', ...(response.headers.has('www-authenticate') ? { 'www-authenticate': response.headers.get('www-authenticate')! } : {}) } });
};
export class LocalOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private refreshInProgress = false;
  private stateValue = randomBytes(32).toString('base64url');
  private snapshot?: OAuthTokens;
  constructor(readonly file: string, readonly serverUrl: string, private interactive?: { redirectUrl: string; open: (url: URL) => Promise<void> }) { readOAuth(file, serverUrl); }
  get redirectUrl() { return this.interactive?.redirectUrl ?? readOAuth(this.file, this.serverUrl).redirectUrl; }
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'Cairn', redirect_uris: this.redirectUrl ? [this.redirectUrl] : [], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  state() { return this.stateValue; }
  private patch(update: Partial<OAuthRecord>) { saveOAuth(this.file, { ...readOAuth(this.file, this.serverUrl), ...update }); }
  clientInformation() { const client = readOAuth(this.file, this.serverUrl).client; if (!client && !this.interactive) { this.patch({ needsLogin: true }); throw new Error('Sign-in required. Open Cairn guided setup.'); } return client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.patch({ client, redirectUrl: this.redirectUrl }); }
  discoveryState() { return readOAuth(this.file, this.serverUrl).discovery; }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    oauthUrl(String(discovery.authorizationServerUrl));
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as const) { const u = discovery.authorizationServerMetadata?.[key]; if (typeof u === 'string') oauthUrl(u); }
    this.patch({ discovery });
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    let r = readOAuth(this.file, this.serverUrl);
    // Proactive refresh serializes across gateway processes sharing a connection.
    // SDK-triggered recovery from an unexpected 401 also remains supported.
    if (!this.refreshInProgress && r.tokens?.refresh_token && r.expiresAt && r.expiresAt < Date.now() + 15_000) {
      privateParent(this.file);
      const lock = `${this.file}.refresh.lock`, deadline = Date.now() + 25_000;
      let fd: number | undefined;
      while (fd === undefined) {
        try { fd = acquireLock(lock); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('OAuth refresh is busy. Retry the connection; if it persists, sign in again through Cairn setup.'); await new Promise((r) => setTimeout(r, 100)); }
      }
      try {
        r = readOAuth(this.file, this.serverUrl);
        if (r.tokens?.refresh_token && r.expiresAt && r.expiresAt < Date.now() + 15_000) {
          this.refreshInProgress = true;
          try { await auth(this, { serverUrl: this.serverUrl, fetchFn: oauthFetch }); }
          catch { this.patch({ needsLogin: true }); throw new Error('Sign-in needs attention. Open Cairn guided setup to reconnect this tool.'); }
        }
      } finally { this.refreshInProgress = false; fs.closeSync(fd); fs.unlinkSync(lock); }
      r = readOAuth(this.file, this.serverUrl);
    }
    this.snapshot = r.tokens;
    return r.tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.patch({ tokens, expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000, needsLogin: false, redirectUrl: this.redirectUrl });
    this.snapshot = tokens;
  }
  async redirectToAuthorization(url: URL) {
    this.patch({ needsLogin: true });
    if (!this.interactive) throw new Error('Sign-in required. Run Cairn guided setup to reconnect this tool.');
    oauthUrl(url.href);
    if (url.searchParams.get('state') !== this.stateValue || !url.searchParams.get('code_challenge') || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Authorization request did not preserve PKCE and state.');
    await this.interactive.open(url);
  }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { if (!this.verifier) throw new Error('No active authorization attempt. Restart sign-in.'); return this.verifier; }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const r = readOAuth(this.file, this.serverUrl);
    // A stale process must not delete a token another process just refreshed.
    if (this.snapshot && r.tokens?.access_token !== this.snapshot.access_token) return;
    if (scope === 'all' || scope === 'client') delete r.client;
    if (scope === 'all' || scope === 'tokens') { delete r.tokens; delete r.expiresAt; r.needsLogin = true; }
    if (scope === 'all' || scope === 'discovery') delete r.discovery;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    saveOAuth(this.file, r);
  }
}

export function openLoginBrowser(url: URL): Promise<void> {
  oauthUrl(url.href);
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Could not open the browser.')); }, 5000);
    child.once('error', () => clearTimeout(timer)); child.once('exit', () => clearTimeout(timer));
    child.once('error', () => reject(new Error('Could not open the browser.')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Could not open the browser.')));
  });
}

/** Returns only a tool count. This verifies connection/authentication, not pilot
 * usage, and never calls an upstream tool or writes activity to the corpus. */
async function signInAttempt(options: { file: string; serverUrl: string; sse?: boolean; timeoutMs?: number; open?: (url: URL) => Promise<void>; signal?: AbortSignal; repair?: boolean }): Promise<{ tools: number }> {
  const serverUrl = oauthUrl(options.serverUrl).href;
  const stored = readOAuth(options.file, serverUrl);
  const controller = new AbortController();
  const fetchAttempt: typeof fetch = (input, init) => oauthFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
  const noncePath = `/cairn/oauth/${randomBytes(16).toString('hex')}`;
  let expectedState = '', completed = false;
  let resolveCode!: (code: string) => void, rejectCode!: (e: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  void code.catch(() => {}); // may time out before the initial network request finishes
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'none'");
    const address = server.address();
    const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    let u: URL;
    try { u = new URL(req.url ?? '/', `http://${host || '127.0.0.1'}`); } catch { res.writeHead(400); res.end('Invalid callback.'); return; }
    const incoming = u.searchParams.get('state') ?? '';
    const validState = !!expectedState && Buffer.byteLength(incoming) === Buffer.byteLength(expectedState) && timingSafeEqual(Buffer.from(incoming), Buffer.from(expectedState));
    if (completed || req.method !== 'GET' || req.headers.host !== host || u.origin !== `http://${host}` || u.pathname !== noncePath || u.searchParams.getAll('state').length !== 1 || !validState) { res.writeHead(400); res.end('This sign-in response is invalid. Return to Cairn setup.'); return; }
    if (u.searchParams.has('error')) { completed = true; res.end('Sign-in was cancelled. You can retry in Cairn setup.'); rejectCode(new Error('Sign-in was cancelled or denied.')); return; }
    const value = u.searchParams.get('code');
    if (!value || value.length > 4096 || u.searchParams.getAll('code').length !== 1) { res.writeHead(400); res.end('Missing authorization code.'); return; }
    completed = true; res.end('Sign-in received. Return to Cairn setup to finish connecting.'); resolveCode(value);
  });
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | SSEClientTransport | undefined;
  const timer = setTimeout(() => { controller.abort(); rejectCode(new Error('Sign-in timed out. Retry in Cairn setup.')); server.closeAllConnections(); }, options.timeoutMs ?? 180_000);
  const abort = () => { controller.abort(); rejectCode(new Error('Sign-in cancelled.')); server.closeAllConnections(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    // Healthy saved credentials connect/refresh without a new registration or browser.
    if (stored.tokens && !stored.needsLogin) {
      try {
        const existing = new LocalOAuthProvider(options.file, serverUrl);
        client = new Client({ name: 'cairn-setup', version: '1' });
        transport = options.sse ? new SSEClientTransport(new URL(serverUrl), { authProvider: existing, fetch: fetchAttempt }) : new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: existing, fetch: fetchAttempt });
        await client.connect(transport);
        const result = await client.listTools({}, { timeout: 20_000 });
        recordConnectionCheck(options.file, serverUrl, result.tools.length);
        return { tools: result.tools.length };
      } catch {
        await client?.close().catch(() => {});
        // An outage or listing failure is not evidence of a revoked login.
        // Only the provider's explicit auth recovery state permits new consent.
        if (!readOAuth(options.file, serverUrl).needsLogin) throw new Error('Connection temporarily unavailable; saved login retained.');
      }
    }
    // Register a new callback per interactive attempt; never reuse another
    // client's credentials or native token cache. Tokens remain URL-bound.
    await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new Error('Could not open the local sign-in callback. Close other sign-in attempts and retry.'))); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as { port: number };
    const redirectUrl = `http://127.0.0.1:${address.port}${noncePath}`;
    // Existing tokens can connect/refresh without browser interaction. If a new
    // authorization is needed, this attempt registers its own redirect URI.
    const provider = new LocalOAuthProvider(options.file, serverUrl, { redirectUrl, open: options.open ?? openLoginBrowser });
    expectedState = provider.state();
    const start = async () => {
      client = new Client({ name: 'cairn-setup', version: '1' });
      transport = options.sse ? new SSEClientTransport(new URL(serverUrl), { authProvider: provider, fetch: fetchAttempt }) : new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: fetchAttempt });
      await client.connect(transport);
    };
    // A new interactive flow requires a registration for this callback. Keep
    // existing tokens first so a healthy connection does not ask for consent.
    provider.invalidateCredentials('all');
    try { await start(); }
    catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      const authorizationCode = await code;
      await transport!.finishAuth(authorizationCode);
      await client?.close(); await start();
    }
    const result = await client!.listTools({}, { timeout: 20_000 });
    recordConnectionCheck(options.file, serverUrl, result.tools.length);
    return { tools: result.tools.length };
  } catch { throw new Error('Connection or sign-in did not finish. This sign-in attempt did not change your tool configuration. Retry guided setup; some providers require administrator approval for a new OAuth client.'); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); await client?.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

/** Serialize browser attempts so two setup windows cannot replace each other's credentials. */
export async function signIn(options: Parameters<typeof signInAttempt>[0]): Promise<{ tools: number }> {
  privateParent(options.file);
  const lock = `${options.file}.login.lock`;
  let fd: number;
  try { fd = acquireLock(lock); } catch { throw new Error('Another sign-in is running for this connection. Finish or close it, then retry.'); }
  try {
    if (options.repair) {
      try { readOAuth(options.file, options.serverUrl); } catch {
        const st = fs.lstatSync(options.file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Linked or shared credential files cannot be repaired automatically.');
        fs.chmodSync(options.file, 0o600);
        fs.renameSync(options.file, `${options.file}.${randomUUID()}.recovery`);
      }
    }
    return await signInAttempt(options);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
