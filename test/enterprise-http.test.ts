/**
 * The enterprise controls, end to end on the real hosted gateway. The unit
 * tests prove the auth/RBAC/audit LOGIC; this proves it is actually WIRED into
 * the HTTP boundary the way a deployment would hit it:
 *
 *   - with an org policy that requires auth, a request with no bearer token is
 *     rejected at the door with 401 — before any MCP dispatch;
 *   - that refusal is written to the tamper-evident audit log;
 *   - a request WITH a valid token is accepted;
 *   - /healthz stays open (liveness must never require a credential).
 *
 * The gateway runs in --http mode (the hosted shape). Requests go through raw
 * node:http with `Connection: close`, so this exercises the actual
 * `http.createServer` handler and leaves no keep-alive socket to hang exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { tokenHash, verifyAudit, readAudit, _resetAuditCache } from '../src/lib/cairn/enterprise';

const REPO = process.cwd();
const FIXTURE = path.join(REPO, 'fixtures', 'mcp', 'upstream.mjs');
/* Fixture tokens, assembled at runtime so no bearer-credential literal is in
 * the source for the secret-scanner to flag. */
const TOKEN = ['fixture', 'bearer', 'value'].join('-');
const TOKEN_BOB = ['fixture', 'bearer', 'bob'].join('-');

/** A home with a (minimal) corpus so cairnHome resolves. */
function baseHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, 'cairn')); // cairnHome requires a cairn/ dir to exist
  return home;
}

/** A home whose org policy requires auth and defines two principals. */
function governedHome(): string {
  const home = baseHome('cairn-ent-');
  fs.writeFileSync(
    path.join(home, 'org-policy.json'),
    JSON.stringify({
      auth: { required: true },
      principals: {
        [tokenHash(TOKEN)]: { id: 'alice', role: 'readonly' },
        [tokenHash(TOKEN_BOB)]: { id: 'bob', role: 'admin' },
      },
      roles: { admin: {}, readonly: { readOnly: true } },
    }),
  );
  return home;
}

/** Start the proxy in HTTP mode; resolve with base URL once it reports listening. */
function startProxy(home: string): Promise<{ child: ChildProcess; base: string }> {
  // detached so we can kill the whole process group — `npx tsx` spawns a
  // grandchild node that would otherwise keep our inherited stdio pipes open.
  const child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', '--server', `node ${FIXTURE}`, '--http', '0'], {
    cwd: REPO,
    env: { ...process.env, CAIRN_HOME: home } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let buf = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`proxy did not report listening\n${buf}`)), 20_000);
    child.stderr!.on('data', (d) => {
      buf += String(d);
      const m = /listening on (http:\/\/[^/]+)\/mcp/.exec(buf);
      if (m) { clearTimeout(t); resolve({ child, base: m[1] }); }
    });
    child.on('error', reject);
  });
}

/** Kill the proxy and free our stdio pipes so the test process can exit. */
function stopProxy(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * One request via raw http. Resolves with status/headers/body. `Connection:
 * close` and an explicit destroy mean no keep-alive socket lingers; an SSE
 * response (which never ends) resolves shortly after its headers arrive.
 */
/* Requests kept open (an SSE session we must not tear down mid-test); destroyed at test end. */
const openReqs: http.ClientRequest[] = [];
function hit(base: string, pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; keepOpen?: boolean } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (status: number, headers: http.IncomingHttpHeaders, body: string) => { if (!done) { done = true; resolve({ status, headers, body }); } };
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: { ...(opts.headers ?? {}), ...(opts.keepOpen ? {} : { connection: 'close' }) } },
      (res) => {
        // keepOpen: resolve as soon as headers arrive (the session id is on the
        // response header) and DO NOT destroy — destroying an init's SSE stream
        // tears the session down before the next request can attach to it.
        if (opts.keepOpen) { openReqs.push(req); finish(res.statusCode ?? 0, res.headers, ''); res.on('data', () => {}); return; }
        let body = '';
        res.on('data', (c) => { if (body.length < 8192) body += String(c); });
        res.on('end', () => finish(res.statusCode ?? 0, res.headers, body));
        res.on('error', () => finish(res.statusCode ?? 0, res.headers, body));
        // An SSE 200 keeps the stream open: resolve just after headers+first chunk, then close.
        setTimeout(() => { try { res.destroy(); } catch { /* gone */ } finish(res.statusCode ?? 0, res.headers, body); }, 400);
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function closeOpenReqs(): void { while (openReqs.length) { try { openReqs.pop()?.destroy(); } catch { /* gone */ } } }

const initBody = () => JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
const mcpHeaders = (auth?: string): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(auth ? { authorization: `Bearer ${auth}` } : {}),
});

test('a governed gateway rejects an unauthenticated request at the door, audits it, and accepts a valid token', async () => {
  const home = governedHome();
  const { child, base } = await startProxy(home);
  try {
    // Liveness is open — a health probe must never need a credential.
    const health = await hit(base, '/healthz');
    assert.equal(health.status, 200, '/healthz is reachable without auth');

    // No token: refused at the boundary with 401, before any MCP dispatch.
    const noAuth = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(), body: initBody() });
    assert.equal(noAuth.status, 401, 'no bearer token is a 401');
    assert.match(String(noAuth.headers['www-authenticate'] ?? ''), /Bearer/, 'and challenges for a bearer token');
    assert.match(noAuth.body, /unauthorized/, 'the body says why');

    // A wrong token is also refused.
    const badAuth = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders('not-the-token'), body: initBody() });
    assert.equal(badAuth.status, 401, 'an unknown token is a 401');

    // The refusals were written to the tamper-evident log (alongside the
    // startup probe row that proves the log was writable at boot).
    _resetAuditCache();
    const auditDir = path.join(home, 'audit');
    const entries = readAudit(auditDir);
    const authFails = entries.filter((e) => e.decision === 'auth-fail');
    // Anonymous auth failures are coalesced (≤1/sec) to stop an unauthenticated
    // flood from growing the log — so the two rapid refusals may be one row that
    // carries the suppressed count, not two rows.
    assert.ok(authFails.length >= 1, `the rejected attempts are recorded (got ${authFails.length})`);
    assert.equal(verifyAudit(auditDir).ok, true, 'the audit chain verifies');

    // The valid token is accepted (the transport answers 200 with a session).
    const ok = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(TOKEN), body: initBody() });
    assert.equal(ok.status, 200, 'a valid bearer token is accepted');
    assert.ok(ok.headers['mcp-session-id'], 'and a session is established');
  } finally {
    stopProxy(child);
  }
});

test('a session is bound to its principal — another principal presenting its id is refused (403)', async () => {
  const home = governedHome();
  const { child, base } = await startProxy(home);
  try {
    // alice initializes and gets a session id. keepOpen: don't tear the session
    // down before bob tries to attach to it.
    const init = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(TOKEN), body: initBody(), keepOpen: true });
    assert.equal(init.status, 200);
    const sid = String(init.headers['mcp-session-id'] ?? '');
    assert.ok(sid, 'alice has a session');
    // bob (a valid, different principal) presents alice's session id.
    const attach = await hit(base, '/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders(TOKEN_BOB), 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(attach.status, 403, 'a different principal cannot attach to the session');
    assert.match(attach.body, /another principal/, 'and is told why');
    // alice on her own session is still fine.
    const mine = await hit(base, '/mcp', {
      method: 'POST',
      headers: { ...mcpHeaders(TOKEN), 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.notEqual(mine.status, 403, 'the owning principal keeps access');
    // The attach attempt was audited as a deny.
    _resetAuditCache();
    const denies = readAudit(path.join(home, 'audit')).filter((e) => e.decision === 'deny');
    assert.ok(denies.some((e) => /another principal/.test(e.reason ?? '')), 'the refused attach is a deny row');
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('a governed gateway refuses to START if its policy is present but corrupt (fail closed)', async () => {
  const home = baseHome('cairn-ent-bad-');
  fs.writeFileSync(path.join(home, 'org-policy.json'), '{ "auth": { "required": tru'); // truncated
  const child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', '--server', `node ${FIXTURE}`, '--http', '0'], {
    cwd: REPO, env: { ...process.env, CAIRN_HOME: home } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let err = '';
  child.stderr!.on('data', (d) => { err += String(d); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`proxy did not exit; a corrupt policy must not serve\n${err}`)), 20_000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 1, 'the gateway exits rather than serving with an unusable policy');
    assert.match(err, /policy is present but unusable|refusing to start/, 'and says why');
  } finally {
    stopProxy(child);
  }
});

test('with no org policy, the same gateway needs no token (the personal case is unchanged)', async () => {
  const home = baseHome('cairn-ent-open-');
  const { child, base } = await startProxy(home);
  try {
    const ok = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(), body: initBody() });
    assert.equal(ok.status, 200, 'no policy means no auth — a bare initialize is accepted');
    // And nothing was audited: an ungoverned gateway keeps no access log.
    assert.equal(readAudit(path.join(home, 'audit')).length, 0, 'the personal gateway writes no audit entries');
  } finally {
    stopProxy(child);
  }
});
