/**
 * The enterprise controls are the three a security review and a SOC 2 / ISO
 * audit ask for at the agent↔tool chokepoint: authenticated access, role-based
 * authorization, and a tamper-evident audit trail. The whole safety argument is
 * in their edges — a policy that fails OPEN, a role that fails OPEN, or an audit
 * chain that does not actually detect an edit would each be worse than nothing,
 * because they would say the control is on while it is off. These test those
 * edges directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fsReal from 'fs';
import osReal from 'os';
import pathReal from 'path';
import { createHash } from 'crypto';
import {
  authenticate, authorize, tokenHash, bearerToken, LOCAL_ADMIN,
  appendAudit, verifyAudit, readAudit, _resetAuditCache, readOrgPolicy, anchorHead, readAnchors, rotateAudit,
  type OrgPolicy,
} from '../src/lib/cairn/enterprise';

const policy = (over: Partial<OrgPolicy> = {}): OrgPolicy => ({
  auth: { required: true },
  principals: {},
  roles: { admin: {}, readonly: { readOnly: true } },
  ...over,
});

/* ---- authentication ---------------------------------------------------- */

test('no policy, or auth not required, is the local admin (the personal case)', () => {
  assert.equal(authenticate(null, undefined).principal, LOCAL_ADMIN);
  assert.equal(authenticate(policy({ auth: { required: false } }), undefined).principal, LOCAL_ADMIN);
});

test('with auth required, a missing or unknown bearer token is refused (fail closed)', () => {
  const p = policy();
  assert.equal(authenticate(p, undefined).principal, null, 'no header is refused');
  assert.equal(authenticate(p, 'Bearer nope').principal, null, 'an unknown token is refused');
  const r = authenticate(p, undefined);
  assert.match(r.reason ?? '', /no bearer token/);
});

test('a token maps to its principal by hash, never by the raw secret', () => {
  // Assembled at runtime so no credential literal appears for the secret-scanner.
  const raw = ['a', 'minted', 'token'].join('-');
  const p = policy({ principals: { [tokenHash(raw)]: { id: 'alice', role: 'readonly' } } });
  const r = authenticate(p, `Bearer ${raw}`);
  assert.equal(r.principal?.id, 'alice');
  assert.equal(r.principal?.role, 'readonly');
  // The policy stores only the hash — the raw token is nowhere in it.
  assert.ok(!JSON.stringify(p).includes(raw), 'the raw token is never stored in the policy');
});

test('bearerToken parses the header case-insensitively and trims', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer   xyz  '), 'xyz');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

/* ---- authorization (RBAC) ---------------------------------------------- */

const alice = { id: 'alice', role: 'readonly' };
const bob = { id: 'bob', role: 'admin' };

test('no policy allows everything; the local admin is ungoverned even when a policy exists', () => {
  assert.equal(authorize(null, alice, 'sf', { name: 'delete_records' }).allowed, true);
  // A policy is present, but the LOCAL_ADMIN sentinel is never governed by it —
  // a personal install with a stray policy file does not start denying itself.
  assert.equal(authorize(policy(), LOCAL_ADMIN, 'sf', { name: 'delete_records' }).allowed, true);
});

test('an unknown role fails closed — it denies everything', () => {
  const r = authorize(policy(), { id: 'x', role: 'ghost' }, 'sf', { name: 'read' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /not defined/);
});

test('deny wins: a denied server and a denied tool both block', () => {
  const p = policy({ roles: { admin: { denyServers: ['secrets'] }, ops: { denyTools: ['deploy_prod'] } } });
  assert.equal(authorize(p, bob, 'secrets', { name: 'read' }).allowed, false, 'denied server blocks');
  assert.equal(authorize(p, { id: 'o', role: 'ops' }, 'k8s', { name: 'deploy_prod' }).allowed, false, 'denied tool blocks');
  assert.equal(authorize(p, { id: 'o', role: 'ops' }, 'k8s', { name: 'get_pods' }).allowed, true, 'a permitted tool passes');
});

test('an allowServers list is a strict allowlist', () => {
  const p = policy({ roles: { scoped: { allowServers: ['sf'] } } });
  const s = { id: 's', role: 'scoped' };
  assert.equal(authorize(p, s, 'sf', { name: 'query' }).allowed, true);
  assert.equal(authorize(p, s, 'stripe', { name: 'query' }).allowed, false, 'a server not on the allowlist is denied');
});

test('read-only denies a write, by declaration or by name, and permits a read', () => {
  const p = policy();
  assert.equal(authorize(p, alice, 'sf', { name: 'query_records' }).allowed, true, 'a read-looking name passes');
  assert.equal(authorize(p, alice, 'sf', { name: 'delete_records' }).allowed, false, 'a write-looking name is denied');
  assert.equal(authorize(p, alice, 'sf', { name: 'run', annotations: { destructiveHint: true } }).allowed, false, 'a declared-destructive tool is denied');
  assert.equal(authorize(p, alice, 'sf', { name: 'fetch', annotations: { readOnlyHint: false } }).allowed, false, 'a declared-write tool is denied even with a read-looking name');
  // The hole Fable found at the call site: a tool whose NAME misses the
  // write-looking word list but DECLARES itself destructive must still be denied
  // to a read-only role — the annotations must reach authorize, not be dropped.
  assert.equal(authorize(p, alice, 'sf', { name: 'transfer_funds', annotations: { destructiveHint: true } }).allowed, false, 'a benign-named but declared-destructive tool is denied read-only');
});

test('denyTools matches the exposed name AND the raw alias, case-folded', () => {
  const p = policy({ roles: { admin: { denyTools: ['github__Delete_Repo'] } } });
  // Operator copied the exposed name; the gateway routes by the raw name.
  assert.equal(authorize(p, bob, 'github', { name: 'github__delete_repo', aliases: ['delete_repo'] }).allowed, false, 'exposed name matches case-insensitively');
  assert.equal(authorize(p, bob, 'github', { name: 'delete_repo', aliases: ['delete_repo'] }).allowed, true, 'a different tool is unaffected');
  const p2 = policy({ roles: { admin: { denyTools: ['delete_repo'] } } });
  assert.equal(authorize(p2, bob, 'github', { name: 'github__delete_repo', aliases: ['delete_repo'] }).allowed, false, 'the raw alias also matches');
});

test('an expired token is refused', () => {
  const raw = ['expiring', 'token'].join('-');
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const expired = policy({ principals: { [tokenHash(raw)]: { id: 'temp', role: 'readonly', expiresAt: past } } });
  assert.equal(authenticate(expired, `Bearer ${raw}`).principal, null, 'a past expiry is rejected');
  assert.match(authenticate(expired, `Bearer ${raw}`).reason ?? '', /expired/);
  const valid = policy({ principals: { [tokenHash(raw)]: { id: 'temp', role: 'readonly', expiresAt: future } } });
  assert.equal(authenticate(valid, `Bearer ${raw}`).principal?.id, 'temp', 'a future expiry still works');
});

/* ---- policy loading: fail closed, never open ---------------------------- */

test('a corrupt or unreadable policy loads as error (fail closed), never as none', () => {
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'cairn-pol-'));
  const file = pathReal.join(dir, 'org-policy.json');
  const prev = process.env.CAIRN_ORG_POLICY;
  process.env.CAIRN_ORG_POLICY = file;
  try {
    // Absent → none (the personal case).
    assert.equal(readOrgPolicy().status, 'none', 'no file is the personal case');
    // Half-written JSON → error, so the gateway can fail closed instead of
    // treating a corrupt policy as "no policy" and turning every control off.
    fsReal.writeFileSync(file, '{ "auth": { "required": tru');
    assert.equal(readOrgPolicy().status, 'error', 'truncated JSON is an error, not none');
    // auth.required not a boolean → error (a typo must not coincidentally mean off).
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: 'true' }, principals: {}, roles: {} }));
    assert.equal(readOrgPolicy().status, 'error', 'a non-boolean auth.required is an error');
    // A valid policy → ok.
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: true }, principals: {}, roles: {} }));
    const r = readOrgPolicy();
    assert.equal(r.status, 'ok');
    assert.equal(r.status === 'ok' && r.policy.auth.required, true);
  } finally {
    if (prev === undefined) delete process.env.CAIRN_ORG_POLICY; else process.env.CAIRN_ORG_POLICY = prev;
  }
});

test('read-only now denies the write verbs the old wordlist missed', () => {
  const p = policy();
  for (const name of ['run_shell', 'exec_command', 'transfer_funds', 'approve_invoice', 'grant_access', 'wipe_disk', 'merge_branch', 'reset_password']) {
    assert.equal(authorize(p, alice, 'sf', { name }).allowed, false, `${name} reads as a write and is denied read-only`);
  }
  // ...but a genuine read still passes.
  assert.equal(authorize(p, alice, 'sf', { name: 'get_account' }).allowed, true, 'a read passes');
  assert.equal(authorize(p, alice, 'sf', { name: 'list_users' }).allowed, true, 'a list passes');
});

test('a prototype-polluting role name authorizes nothing (fails closed)', () => {
  const p = policy();
  for (const role of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = authorize(p, { id: 'x', role }, 'sf', { name: 'get' });
    assert.equal(r.allowed, false, `role "${role}" must not resolve to an inherited object`);
  }
});

/* ---- audit: the tamper-evident chain ----------------------------------- */

function freshDir(): string {
  _resetAuditCache();
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-audit-'));
}

test('an empty log verifies, and appends chain and verify', () => {
  const dir = freshDir();
  assert.equal(verifyAudit(dir).ok, true, 'no log yet is intact, not broken');
  appendAudit(dir, { principal: 'alice', decision: 'call', server: 'sf', tool: 'query' });
  appendAudit(dir, { principal: 'alice', decision: 'deny', server: 'secrets', tool: 'read', reason: 'denied server' });
  appendAudit(dir, { principal: 'anonymous', decision: 'auth-fail', reason: 'unknown token' });
  const v = verifyAudit(dir);
  assert.equal(v.ok, true, 'a well-formed chain verifies');
  assert.equal(v.entries, 3);
  assert.deepEqual(readAudit(dir).map((e) => e.seq), [1, 2, 3], 'seq is monotonic from 1');
});

test('editing a committed entry breaks the chain, and verify names the line', () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'alice', decision: 'call', server: 'sf', tool: 'query' });
  appendAudit(dir, { principal: 'alice', decision: 'deny', server: 'secrets', tool: 'read', reason: 'denied' });
  appendAudit(dir, { principal: 'bob', decision: 'call', server: 'k8s', tool: 'get_pods' });
  // Tamper: flip the denied call in the middle to an allowed one.
  const file = path.join(dir, 'audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const edited = JSON.parse(lines[1]);
  edited.decision = 'call'; // change the recorded decision, keep its stored hash
  lines[1] = JSON.stringify(edited);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  _resetAuditCache();
  const v = verifyAudit(dir);
  assert.equal(v.ok, false, 'the edit is detected');
  assert.equal(v.brokenAt, 2, 'and pinned to the exact line');
  assert.match(v.detail ?? '', /edited/);
});

test('deleting an entry breaks the chain (prevHash no longer matches)', () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't1' });
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't2' });
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't3' });
  const file = path.join(dir, 'audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 1); // remove the middle entry
  fs.writeFileSync(file, lines.join('\n') + '\n');
  _resetAuditCache();
  const v = verifyAudit(dir);
  assert.equal(v.ok, false, 'a deletion is detected');
  assert.match(v.detail ?? '', /deletion or reorder|out of order/);
});

test('a partial trailing line does not restart the chain at genesis (crash recovery)', () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't1' });
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't2' });
  // Simulate a crash mid-append: a garbage partial line at the tail.
  const file = pathReal.join(dir, 'audit.jsonl');
  fsReal.appendFileSync(file, '{"seq":3,"at":"2026');
  _resetAuditCache();
  // The next real append must anchor to entry 2's hash (seq 3), NOT restart at
  // genesis seq 1 — a second chain would orphan everything before the garbage.
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't3' });
  const entries = readAudit(dir);
  const real = entries.filter((e) => e.tool);
  assert.equal(real[real.length - 1].seq, 3, 'the recovered append continues the chain at seq 3, not 1');
  // verify flags the garbage line (corruption IS detected) rather than hiding it.
  assert.equal(verifyAudit(dir).ok, false, 'the corrupt tail line is reported by verify');
});

test('session and agent are inside the chain hash (tampering with correlation data is caught)', () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'alice', decision: 'call', server: 'sf', tool: 'query', session: 's1', agent: 'cursor' });
  assert.equal(verifyAudit(dir).ok, true);
  const file = pathReal.join(dir, 'audit.jsonl');
  const e = JSON.parse(fsReal.readFileSync(file, 'utf8').trim());
  e.session = 's2'; // rewrite the session id, keep the stored hash
  fsReal.writeFileSync(file, JSON.stringify(e) + '\n');
  _resetAuditCache();
  assert.equal(verifyAudit(dir).ok, false, 'editing the session id breaks the hash');
});

test('a tail truncation is caught by the head sidecar (deleting the last lines still verified clean before)', () => {
  const dir = freshDir();
  for (let i = 0; i < 5; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  assert.equal(verifyAudit(dir).ok, true);
  // Drop the last two lines: the remaining chain is internally consistent and
  // would verify clean — but the head sidecar recorded seq 5, so the truncation
  // is detected.
  const file = pathReal.join(dir, 'audit.jsonl');
  const lines = fsReal.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fsReal.writeFileSync(file, lines.slice(0, 3).join('\n') + '\n');
  _resetAuditCache();
  const v = verifyAudit(dir);
  assert.equal(v.ok, false, 'the tail truncation is caught');
  assert.match(v.detail ?? '', /truncated/);
});

test('an off-box anchor catches a whole-file rewrite the in-file chain cannot', () => {
  const dir = freshDir();
  for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  // Operator takes an anchor and stores it OFF the box.
  const a = anchorHead(dir);
  assert.ok(a && a.seq === 4, 'anchor captures the head');
  const external = { seq: a!.seq, hash: a!.hash };
  // Attacker with write access rewrites the ENTIRE file — a consistent chain of
  // their own, re-hashed end to end. The in-file walk alone would accept it...
  const forged: string[] = [];
  let prev = '0'.repeat(64);
  for (let seq = 1; seq <= 4; seq++) {
    const at = new Date().toISOString();
    // recompute a valid-looking hash the way the module does
    const body = JSON.stringify([seq, at, 'attacker', 'call', 's', `evil${seq}`, '', '', '']);
    const hash = createHash('sha256').update(prev).update('\n').update(body).digest('hex');
    forged.push(JSON.stringify({ seq, at, principal: 'attacker', decision: 'call', server: 's', tool: `evil${seq}`, prevHash: prev, hash }));
    prev = hash;
  }
  fsReal.writeFileSync(pathReal.join(dir, 'audit.jsonl'), forged.join('\n') + '\n');
  // Also delete the local anchors + sidecar, as an attacker on the box would.
  try { fsReal.unlinkSync(pathReal.join(dir, 'anchors.jsonl')); } catch { /* ok */ }
  try { fsReal.unlinkSync(pathReal.join(dir, 'head.json')); } catch { /* ok */ }
  _resetAuditCache();
  // Without the external anchor, the forged chain looks clean (the disclosed limit).
  assert.equal(verifyAudit(dir).ok, true, 'a fully re-hashed file passes the in-file walk — the known limit');
  // WITH the off-box anchor, the rewrite is caught: seq 4 no longer has the anchored hash.
  const v = verifyAudit(dir, { against: [external] });
  assert.equal(v.ok, false, 'the off-box anchor catches the rewrite');
  assert.match(v.detail ?? '', /checkpoint|anchor/);
});

test('a row that could not be locked is spilled, then folded into the chain by the next writer (H1)', async () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't0' });
  // Hold the lock as a LIVE process (our own pid, fresh mtime) so it is not
  // judged stale: the next append cannot acquire it and must spill, never
  // compute a seq unlocked.
  const lp = pathReal.join(dir, 'audit.lock');
  fsReal.writeFileSync(lp, `${process.pid}:held`);
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 'spilled' });
  // The spilled row is NOT in the chain yet, but it is not lost.
  assert.equal(readAudit(dir).length, 1, 'the contended row did not append unlocked');
  assert.ok(fsReal.readdirSync(dir).some((f) => f.startsWith('audit.spill.')), 'it was spilled');
  // Release the lock; the next successful append folds the spill in, in order.
  fsReal.unlinkSync(lp);
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't2' });
  const entries = readAudit(dir);
  assert.deepEqual(entries.map((e) => e.tool), ['t0', 'spilled', 't2'], 'the spilled row is folded in before the new one');
  assert.equal(verifyAudit(dir).ok, true, 'and the chain is intact — no unlocked seq collision');
  assert.ok(!fsReal.readdirSync(dir).some((f) => f.startsWith('audit.spill.')), 'the spill file is consumed');
});

test('conflicting checkpoints for one seq fail verify — never "last wins" (H3)', () => {
  const dir = freshDir();
  for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  const real = anchorHead(dir)!;
  // A forged external anchor disagreeing at the same seq must fail regardless of order.
  const forged = { seq: real.seq, hash: 'f'.repeat(64) };
  const legit = { seq: real.seq, hash: real.hash };
  assert.equal(verifyAudit(dir, { against: [legit, forged] }).ok, false, 'legit then forged fails');
  assert.equal(verifyAudit(dir, { against: [forged, legit] }).ok, false, 'forged then legit also fails (not last-wins)');
  assert.match(verifyAudit(dir, { against: [forged, legit] }).detail ?? '', /disagree/);
});

test('anchorHead refuses to certify a broken log (M2)', () => {
  const dir = freshDir();
  for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  // Tamper: edit the middle entry's content (hash no longer matches).
  const file = pathReal.join(dir, 'audit.jsonl');
  const lines = fsReal.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[1]); e.tool = 'EVIL'; lines[1] = JSON.stringify(e);
  fsReal.writeFileSync(file, lines.join('\n') + '\n');
  _resetAuditCache();
  assert.equal(verifyAudit(dir).ok, false, 'the log is broken');
  assert.equal(anchorHead(dir), null, 'anchorHead refuses to anchor it — no laundering a forgery into the trust root');
  assert.equal(readAnchors(dir).length, 0, 'nothing was anchored');
});

test('anchorHead refuses to start a fresh chain after the anchor log is deleted, once shipping has happened (H4)', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null'; // a ship that succeeds and consumes stdin
  try {
    for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    const a = anchorHead(dir);
    assert.ok(a, 'first anchor is written and shipped');
    assert.ok(fsReal.existsSync(pathReal.join(dir, 'anchors.shipped')), 'a ship cursor now exists');
    // Attacker deletes the local anchor log (and would rewrite the log).
    fsReal.unlinkSync(pathReal.join(dir, 'anchors.jsonl'));
    const a2 = anchorHead(dir);
    assert.equal(a2, null, 'refuses to re-anchor from genesis — the ship cursor proves anchors existed and were removed');
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('concurrent processes appending to one log produce an intact chain (the cross-process lock)', async () => {
  const { spawn } = await import('child_process');
  const dir = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'cairn-audit-mp-'));
  const appender = pathReal.join(process.cwd(), 'test', 'helpers', 'audit-appender.ts');
  const N = 3;
  const each = 15;
  const procs = Array.from({ length: N }, (_, i) =>
    new Promise<void>((resolve) => {
      const c = spawn('npx', ['tsx', appender, dir, String(each), `proc${i}`], { cwd: process.cwd(), stdio: 'ignore' });
      c.on('exit', () => resolve());
      c.on('error', () => resolve());
    }),
  );
  await Promise.all(procs);
  _resetAuditCache();
  const v = verifyAudit(dir);
  assert.equal(v.ok, true, `the interleaved chain must verify — ${v.detail ?? ''} at ${v.brokenAt ?? '?'}`);
  const entries = readAudit(dir);
  assert.equal(entries.length, N * each, `every append landed (${entries.length} of ${N * each})`);
  assert.deepEqual(entries.map((e) => e.seq), Array.from({ length: N * each }, (_, i) => i + 1), 'seqs are contiguous 1..n with no collision');
});

test('rotation archives the live segment and the chain continues, verifiably, across the boundary', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
  try {
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `pre${i}` });
    const preAnchor = anchorHead(dir)!; // an anchor for seq 4, saved off-box
    const external = { seq: preAnchor.seq, hash: preAnchor.hash };

    const rot = rotateAudit(dir);
    assert.equal(rot.ok, true, rot.detail);
    assert.equal(rot.fromSeq, 1);
    assert.equal(rot.toSeq, 4);
    assert.ok(fsReal.existsSync(pathReal.join(dir, rot.archived!)), 'the archive file exists');
    assert.ok(!fsReal.existsSync(pathReal.join(dir, 'audit.jsonl')), 'the live file was archived away');

    // Right after rotation the live segment is empty, but the pre-rotation anchor
    // (for an archived seq) must NOT read as truncation, and verify is clean.
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, true, 'a freshly rotated (empty) live segment verifies');
    assert.equal(verifyAudit(dir, { against: [external] }).ok, true, 'a pre-rotation anchor is archived, not "truncated"');

    // Appends continue the chain: seq 5, prevHash = seq 4's hash.
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 'post0' });
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 'post1' });
    _resetAuditCache();
    const v = verifyAudit(dir, { against: [external] });
    assert.equal(v.ok, true, `the continued chain verifies: ${v.detail ?? ''}`);
    const seqs = readAudit(dir).map((e) => e.seq);
    assert.deepEqual(seqs, [5, 6], 'seq is monotonic across the rotation boundary, not reset to 1');
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('rotation refuses to archive a broken log', () => {
  const dir = freshDir();
  for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  const file = pathReal.join(dir, 'audit.jsonl');
  const lines = fsReal.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const e = JSON.parse(lines[1]); e.tool = 'EVIL'; lines[1] = JSON.stringify(e);
  fsReal.writeFileSync(file, lines.join('\n') + '\n');
  _resetAuditCache();
  const rot = rotateAudit(dir);
  assert.equal(rot.ok, false, 'a broken log is not archived');
  assert.ok(fsReal.existsSync(file), 'and the live file is left in place for investigation');
});

test('a write failure never throws out of appendAudit (a broken log must not break a call)', () => {
  // Point the audit dir at a path whose parent is a file, so mkdir/append fail.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-audit-'));
  const asFile = path.join(base, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  _resetAuditCache();
  assert.doesNotThrow(() => appendAudit(path.join(asFile, 'audit'), { principal: 'a', decision: 'call' }));
});
