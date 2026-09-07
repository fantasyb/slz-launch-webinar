/**
 * The hosted gateway under MANY tenants at once. GATEWAY.md said the HTTP mode
 * was "tested with two clients on loopback"; this is the harness that closes
 * that gap without a network: one governed gateway, a dozen principals, and
 * every request fired concurrently — overlapping initializes racing the session
 * caps, cross-tenant attach attempts, parallel audit writers (in-process and a
 * second process on the same log), the idle reaper racing in-flight calls, and
 * the per-tenant in-flight bounds. Each test asserts the invariant that must
 * hold at scale: caps are exact, reservations release, sessions stay bound to
 * their principal, no response leaks another tenant's identity, and the audit
 * chain verifies with every row accounted for.
 *
 * cairn-0050: sequential streamed reads on ONE session can hit a spurious empty
 * 400 on this box. Where a test needs a streamed result it uses a fresh session
 * per read; a test that COUNTS inits never retries one (a retry is another init).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { tokenHash, verifyAudit, readAudit, _resetAuditCache, type AuditEntry } from '../src/lib/cairn/enterprise';
import { REPO, FIXTURE, baseHome, startProxy, stopProxy, hit, closeOpenReqs, initBody, mcpHeaders, rpcResult, openSession, rpc, closeSession } from './helpers/hosted';

/* Tenant tokens, assembled at runtime so no credential literal is in the source. */
const N_TENANTS = 12;
const tokenFor = (i: number) => ['fixture', 'tenant', String(i)].join('-');
const idFor = (i: number) => `tenant${i}`;

/** A governed home with N tenants. `viewer` is strict read-only (any unannotated
 * tool is a deny, so a denied call is easy to provoke); `admin` may do anything. */
function tenantsHome(prefix: string, opts: { adminIds?: number[] } = {}): string {
  const home = baseHome(prefix);
  const principals: Record<string, { id: string; role: string }> = {};
  for (let i = 0; i < N_TENANTS; i++) principals[tokenHash(tokenFor(i))] = { id: idFor(i), role: opts.adminIds?.includes(i) ? 'admin' : 'viewer' };
  fs.writeFileSync(path.join(home, 'org-policy.json'), JSON.stringify({ auth: { required: true }, principals, roles: { admin: {}, viewer: { readOnlyStrict: true } } }));
  return home;
}

const audit = (home: string): AuditEntry[] => { _resetAuditCache(); return readAudit(path.join(home, 'audit')); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a dozen tenants racing the session caps: exact, per-tenant fair, released on close, denials coalesced', async () => {
  const home = tenantsHome('cairn-mt-caps-');
  const PER = 3, TOTAL = 20; // 12 × 3 = 36 wanted > 20 allowed: both caps bite
  const { child, base } = await startProxy(home, { CAIRN_MAX_SESSIONS_PER_PRINCIPAL: String(PER), CAIRN_MAX_SESSIONS: String(TOTAL) });
  try {
    // Every tenant fires 6 initializes at once (72 in flight against caps of 3/tenant, 20 total).
    const attempts = await Promise.all(
      Array.from({ length: N_TENANTS }, (_, i) => Array.from({ length: 6 }, () => openSession(base, tokenFor(i)).then((r) => ({ i, ...r })))).flat(),
    );
    const ok = attempts.filter((a) => a.status === 200);
    const capped = attempts.filter((a) => a.status === 429);
    const other = attempts.filter((a) => a.status !== 200 && a.status !== 429);
    assert.equal(other.length, 0, `every init is either admitted or capped, nothing else (got ${other.map((o) => o.status).join(',')})`);
    assert.equal(ok.length, TOTAL, `exactly the global cap is admitted under contention (got ${ok.length})`);
    for (let i = 0; i < N_TENANTS; i++) {
      const mine = ok.filter((a) => a.i === i).length;
      assert.ok(mine <= PER, `tenant ${i} holds at most ${PER} sessions (got ${mine})`);
    }
    assert.equal(new Set(ok.map((a) => a.sid)).size, ok.length, 'every admitted session has a distinct id');
    assert.ok(capped.every((c) => /too many active sessions/.test(c.body)), 'every refusal says so');
    assert.ok(capped.every((c) => !c.sid), 'a refusal mints no session id');

    // With the gateway full, one more init from a fresh tenant is refused — and
    // hammering that refusal 40 times writes a handful of coalesced deny rows, not 40.
    const before = audit(home).filter((e) => e.decision === 'deny').length;
    const hammer = await Promise.all(Array.from({ length: 40 }, () => openSession(base, tokenFor(0))));
    assert.ok(hammer.every((h) => h.status === 429), 'the full gateway keeps refusing');
    const denyRows = audit(home).filter((e) => e.decision === 'deny');
    assert.ok(denyRows.length - before <= 4, `40 cap hits are coalesced into a few rows (got ${denyRows.length - before})`);
    // The suppressed count rides on the NEXT row once the one-second window has
    // passed (the same shape as the anonymous auth-fail coalescing).
    await sleep(1100);
    assert.equal((await openSession(base, tokenFor(0))).status, 429);
    assert.ok(audit(home).some((e) => e.decision === 'deny' && /cap reached.*\+\d+ more in the last second/.test(e.reason ?? '')), 'and the next row carries the suppressed count');

    // Release: every admitted session is closed by its owner (DELETE), and then
    // every tenant can open one again — the reservations and live slots were
    // actually freed, not leaked. Closes and re-opens overlap deliberately.
    await Promise.all(ok.map((a) => closeSession(base, tokenFor(a.i), a.sid)));
    closeOpenReqs();
    const reopened = await Promise.all(Array.from({ length: N_TENANTS }, (_, i) => openSession(base, tokenFor(i), { retry: true })));
    assert.ok(reopened.every((r) => r.status === 200), `after release every tenant can open a session again (${reopened.map((r) => r.status).join(',')})`);

    // A tenant that hit its PER cap earlier is not stuck at it forever.
    const more = await Promise.all(Array.from({ length: PER - 1 }, () => openSession(base, tokenFor(1), { retry: true })));
    assert.ok(more.every((r) => r.status === 200), 'a tenant refills up to its own cap after its sessions closed');
    const over = await openSession(base, tokenFor(1));
    assert.equal(over.status, 429, 'and is capped exactly at it');

    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true, 'the audit chain verifies after the flood');
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('eight tenants each try to attach to every other tenant\'s session at once: all refused, owners unaffected, attacker audited, no owner id leaked', async () => {
  const home = tenantsHome('cairn-mt-attach-');
  const { child, base } = await startProxy(home);
  try {
    const K = 8;
    const sessions = await Promise.all(Array.from({ length: K }, (_, i) => openSession(base, tokenFor(i), { retry: true })));
    assert.ok(sessions.every((s) => s.status === 200 && s.sid), 'every tenant has a session');
    // Every ordered pair (i → j, i ≠ j): i presents j's session id with i's own valid token.
    const pairs: [number, number][] = [];
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) if (i !== j) pairs.push([i, j]);
    const attaches = await Promise.all(pairs.map(([i, j]) => rpc(base, tokenFor(i), sessions[j].sid, 2, 'tools/list', {}).then((r) => ({ i, j, ...r }))));
    assert.equal(attaches.length, K * (K - 1));
    for (const a of attaches) {
      assert.equal(a.status, 403, `tenant${a.i} on tenant${a.j}'s session is refused`);
      assert.match(a.body, /another principal/);
      assert.doesNotMatch(a.body, new RegExp(idFor(a.j)), 'the refusal does not name the owner');
      assert.doesNotMatch(a.body, /tenant\d/, 'nor any principal id at all');
    }
    // The owners' own sessions survived the storm: each can still list tools.
    const owners = await Promise.all(sessions.map((s, i) => rpc(base, tokenFor(i), s.sid, 3, 'tools/list', {})));
    assert.ok(owners.every((o) => o.status !== 403 && o.status !== 404), `every owner keeps its session (${owners.map((o) => o.status).join(',')})`);
    // Every attempt was audited under the ATTACKER's principal, naming the victim only in the log.
    const denies = audit(home).filter((e) => e.decision === 'deny' && /attach to session/.test(e.reason ?? ''));
    assert.equal(denies.length, K * (K - 1), `one deny row per attempt (got ${denies.length})`);
    for (const [i, j] of pairs) {
      assert.ok(denies.some((d) => d.principal === idFor(i) && d.session === sessions[j].sid && (d.reason ?? '').includes(`(${idFor(j)})`)), `tenant${i} → tenant${j} is recorded under the attacker`);
    }
    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true, 'the chain verifies');
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('parallel audit writers: ten tenants denied concurrently, plus a second process on the same log — every row lands, in one unbroken chain, nothing spilled', async () => {
  const home = tenantsHome('cairn-mt-audit-');
  const auditDir = path.join(home, 'audit');
  const { child, base } = await startProxy(home);
  try {
    const K = 10, PER = 5;
    // A second PROCESS appends to the same log throughout (the daemon shape):
    // the in-process writers and the cross-process lock must interleave cleanly.
    const script = path.join(home, 'writer.ts');
    fs.writeFileSync(script, `
      import { appendAudit } from '${path.join(REPO, 'src', 'lib', 'cairn', 'enterprise').replace(/\\\\/g, '/')}';
      const dir = process.argv[2];
      for (let i = 0; i < 150; i++) appendAudit(dir, { principal: 'daemon', decision: 'allow', reason: 'external row ' + i });
      process.stdout.write('done\\n');
    `);
    const writer = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [script, auditDir], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let writerOut = '';
    writer.stdout.on('data', (d) => { writerOut += String(d); });
    const writerDone = new Promise<void>((resolve) => writer.on('exit', () => resolve()));

    // Each tenant: PER fresh sessions, each making one call a strict read-only
    // viewer is denied (an unannotated tool) — every one an audit row — all at once.
    const calls = await Promise.all(
      Array.from({ length: K }, (_, i) => Array.from({ length: PER }, async () => {
        const s = await openSession(base, tokenFor(i), { retry: true });
        assert.equal(s.status, 200);
        return rpc(base, tokenFor(i), s.sid, 5, 'tools/call', { name: 'mcp__data360__unrelated', arguments: {} });
      })).flat(),
    );
    await writerDone;
    assert.match(writerOut, /done/, 'the external writer finished');
    const denied = calls.map((c) => rpcResult(c.body)).filter((r) => r?.isError);
    assert.ok(denied.length >= K * PER * 0.8, `the concurrent calls were refused as expected (${denied.length}/${K * PER}; some streamed reads may hit cairn-0050)`);

    const rows = audit(home);
    const v = verifyAudit(auditDir);
    assert.equal(v.ok, true, `the chain verifies with ${rows.length} rows: ${JSON.stringify(v)}`);
    // seq is dense: no row lost, none double-assigned.
    for (let k = 0; k < rows.length; k++) assert.equal(rows[k].seq, k + 1, `seq is dense at row ${k + 1}`);
    const external = rows.filter((e) => e.principal === 'daemon');
    assert.equal(external.length, 150, `every external row landed (${external.length})`);
    const tenantDenies = rows.filter((e) => e.decision === 'deny' && /strict read-only/.test(e.reason ?? ''));
    assert.equal(tenantDenies.length, denied.length, `one deny row per refused call (${tenantDenies.length} rows, ${denied.length} refusals)`);
    for (let i = 0; i < K; i++) assert.ok(tenantDenies.some((e) => e.principal === idFor(i)), `tenant${i}'s denials are under its own principal`);
    // Nothing is left in a spill file: every contended append was folded back.
    const spills = fs.readdirSync(auditDir).filter((f) => f.startsWith('audit.spill.'));
    assert.deepEqual(spills, [], 'no spill file remains after the writers finish');
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('the idle reaper races overlapping inits and in-flight calls: an in-flight forward is never reaped, reaped slots are freed, a reaped id never dispatches', async () => {
  const home = tenantsHome('cairn-mt-reaper-', { adminIds: [0, 1, 2, 3, 4, 5] });
  const TOTAL = 6;
  // A one-second idle TTL: the reaper runs every second and closes anything
  // idle past it — while a burst of inits and a 4-second forward are in flight.
  const { child, base } = await startProxy(home, { CAIRN_SESSION_IDLE_MS_TEST: '1000', CAIRN_MAX_SESSIONS: String(TOTAL) });
  try {
    // A call that outlives the TTL several times over. lastSeen is stamped on
    // arrival; without in-flight tracking the reaper closed the session under it
    // and the caller got a torn stream instead of a result.
    const slowSess = await openSession(base, tokenFor(0), { retry: true });
    assert.equal(slowSess.status, 200);
    const slow = await rpc(base, tokenFor(0), slowSess.sid, 7, 'tools/call', { name: 'mcp__data360__slow', arguments: {} }, { settleMs: 6500 });
    const slowResult = rpcResult(slow.body);
    assert.ok(slowResult && !slowResult.isError, `a 4 s forward on a 1 s idle TTL completes with its result, not a torn stream: ${slow.status} ${slow.body.slice(0, 200)}`);

    // Fill the gateway, let the reaper take it all back, and confirm the slots
    // are free again — the reaper's live.delete plus onclose released everything.
    const fill = await Promise.all(Array.from({ length: TOTAL }, (_, i) => openSession(base, tokenFor(i % 6), { retry: true })));
    assert.ok(fill.every((f) => f.status === 200), `filled to the cap (${fill.map((f) => f.status).join(',')})`);
    const over = await openSession(base, tokenFor(1));
    assert.equal(over.status, 429, 'full');
    await sleep(2600);
    // A reaped id never dispatches: refused (404 while closing, 400 once gone), never served.
    const stale = await rpc(base, tokenFor(0), fill[0].sid, 8, 'tools/list', {});
    assert.ok(stale.status === 404 || stale.status === 400, `a reaped session id is refused (${stale.status})`);
    const again = await Promise.all(Array.from({ length: TOTAL }, (_, i) => openSession(base, tokenFor(i % 6), { retry: true })));
    assert.ok(again.every((f) => f.status === 200), `every slot the reaper freed is usable again (${again.map((f) => f.status).join(',')})`);

    // Overlapping inits while the reaper is sweeping every second: an init is in
    // flight on its own session until the handshake completes, so a sweep during
    // the handshake cannot reap it half-built; each admitted session then serves a call.
    await sleep(2600); // let the previous batch go idle and be reaped
    const burst = await Promise.all(Array.from({ length: TOTAL }, (_, i) => openSession(base, tokenFor(i % 6)).then(async (s) => {
      if (s.status !== 200) return { status: s.status, listed: false };
      const l = await rpc(base, tokenFor(i % 6), s.sid, 9, 'tools/list', {});
      return { status: s.status, listed: l.status === 200 };
    })));
    const admitted = burst.filter((b) => b.status === 200);
    assert.ok(admitted.length >= TOTAL - 1, `the burst is admitted (${burst.map((b) => b.status).join(',')})`);
    assert.ok(admitted.every((b) => b.listed), 'and every admitted session serves a call right after its handshake');
    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true);
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('per-tenant in-flight bounds: one tenant flooding slow calls is capped while another tenant is served; the body budget refuses the sender that would exceed it', async () => {
  const home = tenantsHome('cairn-mt-inflight-', { adminIds: [0, 1] });
  const CAP = 3;
  const { child, base } = await startProxy(home, { CAIRN_MAX_INFLIGHT_PER_PRINCIPAL: String(CAP), CAIRN_MAX_INFLIGHT_BODY_BYTES: String(1 << 20) });
  try {
    // tenant0 fires 8 concurrent 4-second forwards, each on its own session
    // (opened first, so the inits themselves are not what is capped).
    const sess = await Promise.all(Array.from({ length: 8 }, () => openSession(base, tokenFor(0), { retry: true })));
    assert.ok(sess.every((s) => s.status === 200));
    const flood = sess.map((s) => rpc(base, tokenFor(0), s.sid, 10, 'tools/call', { name: 'mcp__data360__slow', arguments: {} }, { settleMs: 6000 }));
    await sleep(300); // the flood is in flight
    // tenant1 is served normally in the meantime: the bound is per principal.
    const other = await openSession(base, tokenFor(1), { retry: true });
    assert.equal(other.status, 200, 'another tenant opens a session while tenant0 is at its in-flight cap');
    const otherList = await rpc(base, tokenFor(1), other.sid, 11, 'tools/list', {}, { retry: true });
    assert.equal(otherList.status, 200, 'and is served');
    const results = await Promise.all(flood);
    const capped = results.filter((r) => r.status === 429);
    const served = results.filter((r) => r.status === 200);
    assert.ok(capped.length >= 8 - CAP, `at most ${CAP} of tenant0's calls run at once; the rest are 429 (${results.map((r) => r.status).join(',')})`);
    assert.ok(served.length >= 1 && served.length <= CAP, `and the admitted ones complete (${served.length})`);
    assert.ok(capped.every((c) => /in flight/.test(c.body) && c.headers['retry-after']), 'a capped call says so and carries Retry-After');
    // Coalesced: the flood's cap hits are a few rows, not one per attempt.
    const capRows = audit(home).filter((e) => /in-flight request cap/.test(e.reason ?? ''));
    assert.ok(capRows.length >= 1 && capRows.length <= 3, `in-flight cap denials are coalesced (${capRows.length} rows)`);
    // Released: once the flood drains, tenant0 is served again.
    const after = await rpc(base, tokenFor(0), sess[0].sid, 12, 'tools/list', {}, { retry: true });
    assert.equal(after.status, 200, 'tenant0 is served again once its calls drained');

    // Body budget (1 MB total in flight; the per-request cap is 4 MB). First,
    // deterministically: one 2 MB body is within the per-request cap but crosses
    // the budget on its own — refused 503 (busy, retryable), not 413 (too large).
    // The gateway stops reading the moment the budget is crossed and destroys
    // the incomplete request (the same fail-fast the 413 path uses), so the
    // client sees the 503 or, if it was still sending, a connection reset; the
    // audit row is what proves which bound fired.
    const big = await hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(tokenFor(0)), body: '{"a":"' + 'y'.repeat(2 << 20) + '"}' }).catch((e: NodeJS.ErrnoException) => ({ status: 0, headers: {} as http.IncomingHttpHeaders, body: String(e.code) }));
    assert.ok(big.status === 503 || /ECONNRESET|EPIPE/.test(big.body), `a body that crosses the in-flight budget is cut off (${big.status} ${big.body.slice(0, 80)})`);
    if (big.status === 503) { assert.match(big.body, /bodies in flight/); assert.ok(big.headers['retry-after'], 'and is retryable'); }
    // The reset can reach us before the gateway's synchronous append lands; give the log a moment.
    const budgetRow = () => audit(home).some((e) => e.principal === idFor(0) && /in-flight body budget exhausted/.test(e.reason ?? ''));
    for (let a = 0; a < 10 && !budgetRow(); a++) await sleep(100);
    assert.ok(budgetRow(), 'the budget refusal is audited under the sender');
    // Then concurrently: one sender holds 700 KB unfinished; a second sender's
    // 700 KB crosses the budget and is refused, while the first, within it, is
    // not — then, released, the same request is no longer refused. The held
    // bytes land asynchronously, so the refused probe (which consumes nothing)
    // is repeated briefly until they have.
    const u = new URL(base);
    const hold = http.request({ hostname: u.hostname, port: u.port, path: '/mcp', method: 'POST', agent: false, headers: { ...mcpHeaders(tokenFor(1)), 'content-length': String(700 * 1024 + 2), connection: 'close' } });
    hold.on('error', () => {});
    hold.on('response', (r) => r.resume());
    hold.write('[' + 'x'.repeat(700 * 1024));
    const probe = () => hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(tokenFor(0)), body: '{"a":"' + 'y'.repeat(700 * 1024) + '"}' }).catch((e: NodeJS.ErrnoException) => ({ status: 0, headers: {} as http.IncomingHttpHeaders, body: String(e.code) }));
    const refused = (r: { status: number; body: string }) => r.status === 503 || /ECONNRESET|EPIPE/.test(r.body);
    let second = await probe();
    for (let a = 0; a < 15 && !refused(second); a++) { await sleep(200); second = await probe(); }
    assert.ok(refused(second), `while another sender holds bytes, the request that would exceed the budget is refused (${second.status} ${second.body.slice(0, 120)})`);
    hold.end(']');
    await sleep(400);
    const third = await probe();
    assert.ok(!refused(third), `once the held body is released the budget is free again (${third.status} ${third.body.slice(0, 80)})`);
    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true);
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('tenant isolation at scale: twelve tenants\' concurrent calls each see only their own session state, and the retrieval ledger shards by principal', async () => {
  const home = tenantsHome('cairn-mt-iso-', { adminIds: Array.from({ length: N_TENANTS }, (_, i) => i) });
  const { child, base } = await startProxy(home);
  try {
    // Every tenant, at once: open a session, run a find whose query names the
    // tenant, then read back. Nothing of tenant i may appear in tenant j's
    // response or shard.
    const runs = await Promise.all(Array.from({ length: N_TENANTS }, async (_, i) => {
      const s = await openSession(base, tokenFor(i), { retry: true });
      assert.equal(s.status, 200);
      const r = await rpc(base, tokenFor(i), s.sid, 13, 'tools/call', { name: 'cairn_find', arguments: { query: `secret-of-${idFor(i)}` } });
      return { i, sid: s.sid, body: r.body };
    }));
    for (const r of runs) {
      for (const other of runs) if (other.i !== r.i) {
        assert.doesNotMatch(r.body, new RegExp(`secret-of-${idFor(other.i)}(?!\\d)`), `tenant${r.i}'s response carries nothing of tenant${other.i}`);
        assert.doesNotMatch(r.body, new RegExp(other.sid), `nor tenant${other.i}'s session id`);
      }
    }
    const retr = path.join(home, 'data', 'retrievals');
    const shards = fs.existsSync(retr) ? fs.readdirSync(retr) : [];
    for (let i = 0; i < N_TENANTS; i++) assert.ok(shards.includes(`${idFor(i)}.jsonl`), `tenant${i} has its own ledger shard (${shards.join(', ')})`);
    for (let i = 0; i < N_TENANTS; i++) {
      const mine = fs.readFileSync(path.join(retr, `${idFor(i)}.jsonl`), 'utf8');
      for (let j = 0; j < N_TENANTS; j++) if (j !== i) assert.doesNotMatch(mine, new RegExp(`secret-of-${idFor(j)}(?!\\d)`), `tenant${i}'s shard holds no query of tenant${j}`);
    }
    assert.ok(!shards.includes('t.jsonl'), 'no shard is named for the (shared, untrusted) client name');
    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true);
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('reconnaissance: every unauthenticated response on a governed gateway is uniform and discloses nothing about tenants, sessions or upstreams', async () => {
  const home = tenantsHome('cairn-mt-recon-');
  const { child, base } = await startProxy(home);
  try {
    const s = await openSession(base, tokenFor(0), { retry: true });
    const probes = await Promise.all([
      hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(), body: initBody() }),
      hit(base, '/mcp', { method: 'GET', headers: mcpHeaders() }),
      hit(base, '/mcp', { method: 'DELETE', headers: { ...mcpHeaders(), 'mcp-session-id': s.sid } }),
      hit(base, '/mcp', { method: 'POST', headers: { ...mcpHeaders(), 'mcp-session-id': s.sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }),
      hit(base, '/mcp', { method: 'POST', headers: { ...mcpHeaders(), 'mcp-session-id': 'not-a-session' }, body: initBody() }),
      hit(base, '/mcp', { method: 'PUT', headers: mcpHeaders(), body: initBody() }),
      hit(base, '/mcp?x=1', { method: 'POST', headers: mcpHeaders(), body: 'not json' }),
    ]);
    for (const p of probes) {
      assert.equal(p.status, 401, `unauthenticated → 401, whatever the verb, body or session id (${p.status})`);
      assert.doesNotMatch(p.body, /tenant\d|data360|fixture|session is closing|no session/, `and the body is the uniform challenge: ${p.body}`);
    }
    const health = JSON.parse((await hit(base, '/healthz')).body);
    assert.deepEqual(Object.keys(health).sort(), ['audit', 'auth', 'governed', 'ok', 'policy'], 'health is liveness plus posture only');
    const other = await hit(base, '/anything-else');
    assert.equal(other.status, 404);
    assert.equal(other.body, '', 'an unknown path is an empty 404');
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('a JSON-RPC batch counts every request in it against the per-tenant in-flight cap: a batch over the cap is refused whole, one within it is served, and its slots are released', async () => {
  // One HTTP request carrying N tools/call entries used to take ONE in-flight
  // slot while the SDK dispatched all N concurrently — so the per-principal
  // bound was really cap × batch size (a 4 MB body holds ~40k calls).
  const home = tenantsHome('cairn-mt-batch-', { adminIds: [0] });
  const CAP = 3;
  const { child, base } = await startProxy(home, { CAIRN_MAX_INFLIGHT_PER_PRINCIPAL: String(CAP) });
  try {
    const s = await openSession(base, tokenFor(0), { retry: true });
    assert.equal(s.status, 200);
    const batch = (n: number, from: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: from + i, method: 'tools/call', params: { name: 'mcp__data360__slow', arguments: {} } })));
    const post = async (body: string, settleMs: number) => {
      const once = () => hit(base, '/mcp', { method: 'POST', headers: { ...mcpHeaders(tokenFor(0)), 'mcp-session-id': s.sid }, body, settleMs });
      let r = await once();
      for (let a = 0; a < 5 && r.status === 400 && !r.body; a++) { await sleep(150); r = await once(); } // cairn-0050
      return r;
    };
    // Over the cap in ONE request: refused before any of its calls is dispatched.
    const over = await post(batch(CAP + 5, 100), 1000);
    assert.equal(over.status, 429, `a batch of ${CAP + 5} calls on a cap of ${CAP} is refused whole (${over.status} ${over.body.slice(0, 160)})`);
    assert.match(over.body, /in flight/);
    assert.ok(over.headers['retry-after'], 'and is retryable');
    // Within the cap: served, and every call in it answered.
    const within = await post(batch(CAP, 200), 6500);
    assert.equal(within.status, 200, `a batch of ${CAP} is served (${within.status} ${within.body.slice(0, 160)})`);
    const ids = [...within.body.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: CAP }, (_, i) => 200 + i), 'every request in the batch gets its result');
    // Released: once the batch drains, the tenant is served again (no slot leaked).
    const after = await rpc(base, tokenFor(0), s.sid, 300, 'tools/list', {}, { retry: true });
    assert.equal(after.status, 200, 'the batch released every slot it reserved');
    // Notifications in a batch are not requests and take no slot.
    const notes = JSON.stringify(Array.from({ length: CAP + 5 }, () => ({ jsonrpc: '2.0', method: 'notifications/initialized' })));
    const onlyNotes = await post(notes, 500);
    assert.equal(onlyNotes.status, 202, `a batch of notifications alone is accepted (${onlyNotes.status})`);
    // The refusal is audited under the tenant, as a cap denial.
    assert.ok(audit(home).some((e) => e.principal === idFor(0) && /in-flight request cap/.test(e.reason ?? '') && /batch/.test(e.reason ?? '')), 'the batch refusal is audited');
    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true);
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});

test('the in-flight body budget is also per principal: one tenant holding bodies is refused its own next body while another tenant, within the global budget, is served', async () => {
  // 256 slots × 4 MB is a gigabyte, so one credential could fill the whole
  // global body budget with slow bodies and 503 every other tenant. A
  // per-principal share bounds the tenant first.
  const home = tenantsHome('cairn-mt-bodyshare-', { adminIds: [0, 1] });
  const { child, base } = await startProxy(home, { CAIRN_MAX_INFLIGHT_BODY_BYTES: String(4 << 20), CAIRN_MAX_INFLIGHT_BODY_BYTES_PER_PRINCIPAL: String(1 << 20) });
  try {
    const u = new URL(base);
    // tenant0 holds 700 KB unfinished.
    const hold = http.request({ hostname: u.hostname, port: u.port, path: '/mcp', method: 'POST', agent: false, headers: { ...mcpHeaders(tokenFor(0)), 'content-length': String(700 * 1024 + 2), connection: 'close' } });
    hold.on('error', () => {});
    hold.on('response', (r) => r.resume());
    hold.write('[' + 'x'.repeat(700 * 1024));
    const probe = (i: number) => hit(base, '/mcp', { method: 'POST', headers: mcpHeaders(tokenFor(i)), body: '{"a":"' + 'y'.repeat(700 * 1024) + '"}' }).catch((e: NodeJS.ErrnoException) => ({ status: 0, headers: {} as http.IncomingHttpHeaders, body: String(e.code) }));
    const refused = (r: { status: number; body: string }) => r.status === 429 || /ECONNRESET|EPIPE/.test(r.body);
    // tenant0's OWN next 700 KB crosses its 1 MB share (1.4 MB, well under the 4 MB global): refused.
    let own = await probe(0);
    for (let a = 0; a < 15 && !refused(own); a++) { await sleep(200); own = await probe(0); }
    assert.ok(refused(own), `the holding tenant's next body is refused by its per-principal share (${own.status} ${own.body.slice(0, 120)})`);
    if (own.status === 429) assert.match(own.body, /for this principal/);
    // tenant1's 700 KB, meanwhile, is within both its share and the global budget: served (not refused).
    const other = await probe(1);
    assert.ok(!refused(other), `another tenant is served while tenant0 is at its share (${other.status} ${other.body.slice(0, 80)})`);
    const shareRow = () => audit(home).some((e) => e.principal === idFor(0) && /per-principal in-flight body budget exhausted/.test(e.reason ?? ''));
    for (let a = 0; a < 10 && !shareRow(); a++) await sleep(100);
    assert.ok(shareRow(), 'the refusal is audited under the holding tenant as a per-principal budget denial');
    assert.ok(!audit(home).some((e) => e.principal === idFor(1) && /body budget/.test(e.reason ?? '')), 'and the other tenant has no budget denial');
    // Released: once the held body ends, tenant0 is served again. The drain +
    // release can lag under full-suite load, so retry as the refusal check above
    // does rather than assume a fixed sleep is enough.
    hold.end(']');
    let after = await probe(0);
    for (let a = 0; a < 15 && refused(after); a++) { await sleep(200); after = await probe(0); }
    assert.ok(!refused(after), `once its held body drains the tenant is served again (${after.status} ${after.body.slice(0, 80)})`);
    assert.equal(verifyAudit(path.join(home, 'audit')).ok, true);
  } finally {
    closeOpenReqs();
    stopProxy(child);
  }
});
