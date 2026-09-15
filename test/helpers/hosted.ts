/**
 * Drivers for the HOSTED gateway (`--http`): start it as a child, hit it over
 * raw node:http, tear it down. Shared by the enterprise HTTP tests and the
 * multi-tenant concurrency harness so both exercise the same handler the same
 * way. Requests go through `Connection: close` by default so no keep-alive
 * socket hangs the test process's exit.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';

export const REPO = process.cwd();
/** The built launcher: requires the fresh bundle (pretest builds it) instead of
 * a per-spawn tsx compile — cheap enough that many concurrent gateway children
 * no longer starve each other (cairn-0050). */
export const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js');
export const FIXTURE = path.join(REPO, 'fixtures', 'mcp', 'upstream.mjs');

/** A home with a (minimal) corpus so cairnHome resolves. */
export function baseHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, 'cairn')); // cairnHome requires a cairn/ dir to exist
  return home;
}

/** Start the proxy in HTTP mode; resolve with base URL once it reports listening. */
export function startProxy(home: string, env: Record<string, string> = {}, serverArgs: string[] = ['--server', `node ${FIXTURE}`]): Promise<{ child: ChildProcess; base: string }> {
  // detached so we can kill the whole process group — `npx tsx` spawns a
  // grandchild node that would otherwise keep our inherited stdio pipes open.
  const child = spawn(process.execPath, [PROXY_BIN, ...serverArgs, '--http', '0'], {
    cwd: REPO,
    env: { ...process.env, CAIRN_HOME: home, ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let buf = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`proxy did not report listening\n${buf}`)), 20_000);
    child.stderr!.on('data', (d) => {
      buf += String(d);
      const m = /listening on (http:\/\/[^/]+)\/mcp/.exec(buf);
      // A wildcard bind (0.0.0.0/::) reports the bind host but is reached over
      // loopback; rewrite the base so the test connects to a routable address.
      if (m) { clearTimeout(t); resolve({ child, base: m[1].replace('0.0.0.0', '127.0.0.1').replace('[::]', '127.0.0.1') }); }
    });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`proxy exited (${code}) before listening\n${buf}`)); });
    child.on('error', reject);
  });
}

/** Start the proxy expecting it to REFUSE to start; resolve with its exit code and stderr. */
export function startProxyExpectingExit(home: string, env: Record<string, string> = {}, serverArgs: string[] = ['--server', `node ${FIXTURE}`]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [PROXY_BIN, ...serverArgs, '--http', '0'], {
    cwd: REPO, env: { ...process.env, CAIRN_HOME: home, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let err = '';
  child.stderr!.on('data', (d) => { err += String(d); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { stopProxy(child); reject(new Error(`proxy did not exit\n${err}`)); }, 20_000);
    child.on('exit', (code) => { clearTimeout(t); stopProxy(child); resolve({ code, stderr: err }); });
    child.on('error', reject);
  });
}

/** Kill the proxy and free our stdio pipes so the test process can exit. */
export function stopProxy(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export interface Hit { status: number; headers: http.IncomingHttpHeaders; body: string }

/* Requests kept open (an SSE session we must not tear down mid-test); destroyed at test end. */
const openReqs: http.ClientRequest[] = [];
/**
 * One request via raw http. Resolves with status/headers/body. `Connection:
 * close` and an explicit destroy mean no keep-alive socket lingers; an SSE
 * response (which never ends) resolves shortly after its headers arrive.
 * keepOpen: resolve as soon as headers arrive (the session id is on the
 * response header) and DO NOT destroy — destroying an init's SSE stream tears
 * the session down before the next request can attach to it.
 * settleMs: how long to wait for a streamed (SSE) body before resolving.
 */
export function hit(base: string, pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; keepOpen?: boolean; settleMs?: number } = {}): Promise<Hit> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (status: number, headers: http.IncomingHttpHeaders, body: string) => { if (!done) { done = true; resolve({ status, headers, body }); } };
    // agent:false — a FRESH socket per request, never one from a pool. Node 22's
    // global agent is keep-alive by default and will hand a later request a
    // socket the gateway has already finished with (a POST whose per-request SSE
    // stream ended, or one refused before its body was read); that request then
    // lands as "data after Connection: close" and gets Node's bare, body-less 400
    // (or a reset) — the spurious empty 400 the older tests retry around.
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', agent: false, headers: { ...(opts.headers ?? {}), ...(opts.keepOpen ? {} : { connection: 'close' }) } },
      (res) => {
        // Only a 200 opens a stream worth keeping; a refusal (401/403/429…) has a
        // body that says why, which the caller wants — read it as usual.
        if (opts.keepOpen && (res.statusCode ?? 0) === 200) { openReqs.push(req); finish(res.statusCode ?? 0, res.headers, ''); res.on('data', () => {}); return; }
        let body = '';
        res.on('data', (c) => { if (body.length < 8192) body += String(c); });
        res.on('end', () => finish(res.statusCode ?? 0, res.headers, body));
        res.on('error', () => finish(res.statusCode ?? 0, res.headers, body));
        // An SSE 200 keeps the stream open: resolve just after headers+first chunk, then close.
        setTimeout(() => { try { res.destroy(); } catch { /* gone */ } finish(res.statusCode ?? 0, res.headers, body); }, opts.settleMs ?? 400);
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
export function closeOpenReqs(): void { while (openReqs.length) { try { openReqs.pop()?.destroy(); } catch { /* gone */ } } }

export const initBody = () => JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
export const mcpHeaders = (auth?: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(auth ? { authorization: `Bearer ${auth}` } : {}),
  ...extra,
});

/** The JSON-RPC result inside a POST reply — an SSE stream (`data: {...}` lines) or plain JSON. */
export function rpcResult(body: string): { isError?: boolean; content?: { text?: string }[] } | undefined {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { const m = JSON.parse(line.slice(5).trim()); if (m.result) return m.result; } catch { /* not this line */ }
  }
  try { return JSON.parse(body).result; } catch { return undefined; }
}

/**
 * Initialize one session for a token and keep its stream open; returns the
 * session id. A prior request's SSE stream can leave the next init a spurious
 * empty 400 on this box (cairn-0050 territory); retried a few times when
 * `retry` is set, which a cap test must NOT do (a retry is another init).
 */
export async function openSession(base: string, token: string | undefined, opts: { retry?: boolean; extraHeaders?: Record<string, string> } = {}): Promise<{ sid: string; status: number; body: string }> {
  let init = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(token, opts.extraHeaders), body: initBody(), keepOpen: true });
  for (let a = 0; opts.retry && a < 5 && init.status !== 200; a++) {
    await new Promise((r) => setTimeout(r, 200));
    init = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(token, opts.extraHeaders), body: initBody(), keepOpen: true });
  }
  return { sid: String(init.headers['mcp-session-id'] ?? ''), status: init.status, body: init.body };
}

/** One JSON-RPC request on an existing session. `retry`: re-send on the spurious
 * empty 400 a streamed read can hit on this box (cairn-0050) — never for a
 * request whose count or timing is what the test measures. */
export async function rpc(base: string, token: string | undefined, sid: string, id: number, method: string, params: unknown, opts: { settleMs?: number; extraHeaders?: Record<string, string>; retry?: boolean } = {}): Promise<Hit> {
  const once = () => hit(base, '/mcp', {
    method: 'POST',
    headers: { ...mcpHeaders(token, opts.extraHeaders), 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    settleMs: opts.settleMs,
  });
  let r = await once();
  for (let a = 0; opts.retry && a < 5 && r.status === 400 && !r.body; a++) {
    await new Promise((res) => setTimeout(res, 150));
    r = await once();
  }
  return r;
}

/** Terminate a session (the client-driven teardown path: DELETE → onsessionclosed). */
export function closeSession(base: string, token: string | undefined, sid: string, extraHeaders: Record<string, string> = {}): Promise<Hit> {
  return hit(base, '/mcp', { method: 'DELETE', headers: { ...mcpHeaders(token, extraHeaders), 'mcp-session-id': sid } });
}
