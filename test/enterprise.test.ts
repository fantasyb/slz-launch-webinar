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
  authenticate, authorize, tokenHash, bearerToken, LOCAL_ADMIN, PROTOCOL_READ,
  appendAudit, verifyAudit, readAudit, _resetAuditCache, readOrgPolicy, anchorHead, readAnchors, rotateAudit, offloadArchive,
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

test('denyTools matches a Unicode look-alike name, not just the exact bytes (Fable-6 #3)', () => {
  const p = policy({ roles: { ops: { denyTools: ['delete_repo'] } } });
  const o = { id: 'o', role: 'ops' };
  assert.equal(authorize(p, o, 'gh', { name: 'delete_repo' }).allowed, false, 'the exact name is denied');
  assert.equal(authorize(p, o, 'gh', { name: 'dеlete_repo' }).allowed, false, 'a Cyrillic-е look-alike is denied too');
  assert.equal(authorize(p, o, 'gh', { name: 'DELETE_REPO' }).allowed, false, 'case does not evade');
});

test('readOnlyStrict denies any tool not declared readOnlyHint:true (Fable-6 #3)', () => {
  const p = policy({ roles: { viewer: { readOnlyStrict: true } } });
  const v = { id: 'v', role: 'viewer' };
  // A tool the server DECLARES read-only is allowed.
  assert.equal(authorize(p, v, 'sf', { name: 'get_thing', annotations: { readOnlyHint: true } }).allowed, true);
  // Everything else is denied — an unannotated read-looking name (which plain
  // readOnly would allow), and a write-declared tool.
  assert.equal(authorize(p, v, 'sf', { name: 'list_things' }).allowed, false, 'unannotated is denied under strict');
  assert.equal(authorize(p, v, 'sf', { name: 'get_thing' }).allowed, false, 'even a read-looking name needs the annotation');
  assert.equal(authorize(p, v, 'sf', { name: 'x', annotations: { readOnlyHint: false } }).allowed, false, 'a write-declared tool is denied');
  // Plain readOnly (non-strict) still trusts a read-looking name.
  const p2 = policy({ roles: { viewer: { readOnly: true } } });
  assert.equal(authorize(p2, v, 'sf', { name: 'list_things' }).allowed, true, 'non-strict readOnly allows a read-looking name');
});

test('readOnlyStrict permits a protocol-level READ (resources/prompts/completions) while still denying an unannotated tool', () => {
  // The gateway routes every non-tool read (resources/read, prompts/get,
  // completion/complete and their lists) through authorize() with PROTOCOL_READ.
  // Strict mode refuses any TOOL not declared readOnlyHint:true; it used to see a
  // bare, unannotated descriptor for these reads and deny them all — a read-only
  // principal that could not read. The descriptor declares what the protocol
  // guarantees, so strict read-only now means "may read, may not write".
  const p = policy({ roles: { viewer: { readOnlyStrict: true }, scoped: { readOnlyStrict: true, allowServers: ['docs'] }, blocked: { readOnlyStrict: true, denyServers: ['secrets'] } } });
  const v = { id: 'v', role: 'viewer' };
  assert.equal(authorize(p, v, 'sf', PROTOCOL_READ).allowed, true, 'a strict read-only role may perform a protocol-level read');
  assert.equal(authorize(p, v, 'sf', { name: 'list_things' }).allowed, false, 'an unannotated TOOL is still denied under strict — the tool boundary is unchanged');
  assert.equal(authorize(p, v, 'sf', { name: 'x', annotations: { readOnlyHint: false } }).allowed, false, 'a write-declared tool is still denied');
  // Server allow/deny still govern the read: PROTOCOL_READ only settles the
  // read-only question, never the reachability one.
  assert.equal(authorize(p, { id: 's', role: 'scoped' }, 'docs', PROTOCOL_READ).allowed, true, 'a read on an allowed server passes');
  assert.equal(authorize(p, { id: 's', role: 'scoped' }, 'secrets', PROTOCOL_READ).allowed, false, 'a read on a server outside allowServers is denied');
  assert.equal(authorize(p, { id: 'b', role: 'blocked' }, 'secrets', PROTOCOL_READ).allowed, false, 'a read on a denied server is denied');
  // The descriptor is frozen: no caller can flip the one annotation every read rides on.
  assert.ok(Object.isFrozen(PROTOCOL_READ) && Object.isFrozen(PROTOCOL_READ.annotations), 'PROTOCOL_READ is immutable');
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
  // Fable-5: an unparseable expiry must FAIL CLOSED, not mean "never expires".
  const bad = policy({ principals: { [tokenHash(raw)]: { id: 'temp', role: 'readonly', expiresAt: '2026-13-45T99:99Z' } } });
  const br = authenticate(bad, `Bearer ${raw}`);
  assert.equal(br.principal, null, 'a token with an unparseable expiresAt is rejected, not perpetual');
  assert.match(br.reason ?? '', /unparseable/);
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
    // Shape typos fail CLOSED (red-team #6): a STRING allowServers turns .includes
    // into a substring test; a principal without an id pools its ledger with the
    // operator's; a non-boolean readOnly is not a coincidental "off".
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: true }, roles: { r: { allowServers: 'github' } } }));
    assert.equal(readOrgPolicy().status, 'error', 'a string allowServers is rejected');
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: true }, principals: { h: { role: 'admin' } } }));
    assert.equal(readOrgPolicy().status, 'error', 'a principal without an id is rejected');
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: true }, roles: { r: { denyTools: ['x', 3] } } }));
    assert.equal(readOrgPolicy().status, 'error', 'a non-string denyTools entry is rejected');
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: true }, roles: { r: { readOnly: 'yes' } } }));
    assert.equal(readOrgPolicy().status, 'error', 'a non-boolean readOnly is rejected');
    // A correctly-shaped policy with roles still loads.
    fsReal.writeFileSync(file, JSON.stringify({ auth: { required: true }, principals: { h: { id: 'alice', role: 'ro' } }, roles: { ro: { readOnly: true, allowServers: ['github'] } } }));
    assert.equal(readOrgPolicy().status, 'ok', 'a well-shaped policy loads');
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

test('a read-only role classifies the TOOL name, not the server name that prefixes it', () => {
  const p = policy();
  const ro = { id: 'r', role: 'readonly' };
  // A server whose NAME starts with a write verb (zap/drop/post/send/run/push)
  // used to make every one of its tools read as a write.
  for (const [server, read, write] of [
    ['zapier', 'list_zaps', 'delete_zap'],
    ['dropbox', 'list_folder', 'move_file'],
    ['postgres', 'describe_table', 'execute_sql'],
    ['sendgrid', 'get_stats', 'send_mail'],
    ['runpod', 'get_pod', 'terminate_pod'],
    ['pushover', 'list_devices', 'push_message'],
  ] as const) {
    const exposed = (raw: string) => ({ name: `${server}__${raw}`, aliases: [raw] });
    assert.equal(authorize(p, ro, server, exposed(read)).allowed, true, `${server}__${read} is a read`);
    assert.equal(authorize(p, ro, server, exposed(write)).allowed, false, `${server}__${write} is still a write`);
  }
  // The fail-closed direction survives: a raw write masked by a READ-verb server
  // name (red-team #7) is still a write, via the raw alias and the stripped name.
  assert.equal(authorize(p, ro, 'search', { name: 'search__delete_index', aliases: ['delete_index'] }).allowed, false);
  assert.equal(authorize(p, ro, 'search', { name: 'search__delete_index' }).allowed, false, 'even with no alias, the stripped name is classified');
  // Single-upstream gateways expose the raw name unprefixed: unchanged.
  assert.equal(authorize(p, ro, 'zapier', { name: 'list_zaps' }).allowed, true);
  assert.equal(authorize(p, ro, 'zapier', { name: 'delete_zap' }).allowed, false);
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

/** Run `fn` with process.stderr captured, so an alarm the code is REQUIRED to
 * raise can be asserted rather than scrolled past. */
function captureStderr(fn: () => void): string {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stderr.write;
  try { fn(); } finally { process.stderr.write = orig; }
  return out;
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
  // The torn fragment was TRUNCATED under the lock before the append (it was
  // never a chained entry), so the log is clean afterwards — not a permanent
  // CHAIN BROKEN that only a hand-edit could clear. Interior corruption is still
  // caught: see the torn-tail test below.
  assert.equal(verifyAudit(dir).ok, true, 'the healed log verifies');
  assert.ok(!fsReal.readFileSync(file, 'utf8').includes('"at":"2026\n'), 'the fragment is gone, not written past');
});

test('a crash-torn trailing line is tolerated and self-heals; interior or newline-terminated garbage is still CHAIN BROKEN', () => {
  // Torn tail on the LIVE log: verify says so, but does not call it tampering,
  // and anchorHead/rotateAudit/the next append are not blocked by it.
  const dir = freshDir();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't1' });
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't2' });
  const file = pathReal.join(dir, 'audit.jsonl');
  fsReal.appendFileSync(file, '{"seq":3,"at":"2026'); // unterminated, unparseable: exactly what ENOSPC leaves
  _resetAuditCache();
  const torn = verifyAudit(dir);
  assert.equal(torn.ok, true, `a torn tail is a crash, not a tamper: ${torn.detail ?? ''}`);
  assert.match(torn.detail ?? '', /torn, unterminated line/, 'and it is reported, not hidden');
  const a = anchorHead(dir);
  assert.ok(a && a.seq === 2, 'anchoring is not refused by a torn tail');
  assert.ok(fsReal.readFileSync(file, 'utf8').endsWith('\n'), 'anchorHead healed the tail under the lock');
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't3' });
  const healed = verifyAudit(dir);
  assert.equal(healed.ok, true);
  assert.doesNotMatch(healed.detail ?? '', /torn/, 'nothing left to report once healed');
  assert.deepEqual(readAudit(dir).map((e) => e.seq), [1, 2, 3]);

  // A newline-TERMINATED garbage last line is not a torn write (every write is a
  // prefix of `<json>\n`), so it is still tampering.
  fsReal.appendFileSync(file, 'this is not json\n');
  _resetAuditCache();
  assert.equal(verifyAudit(dir).ok, false, 'terminated garbage on the tail is still CHAIN BROKEN');

  // Interior corruption — a fragment that is not the last line — is still caught,
  // at its line, whether or not the file ends cleanly.
  const dir2 = freshDir();
  for (let i = 1; i <= 3; i++) appendAudit(dir2, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  const file2 = pathReal.join(dir2, 'audit.jsonl');
  const lines = fsReal.readFileSync(file2, 'utf8').split('\n').filter(Boolean);
  lines[1] = '{"seq":2,"at":"20';
  fsReal.writeFileSync(file2, lines.join('\n')); // no trailing newline either — still interior
  _resetAuditCache();
  const interior = verifyAudit(dir2);
  assert.equal(interior.ok, false, 'an interior fragment is CHAIN BROKEN');
  assert.equal(interior.brokenAt, 2);

  // A deliberate truncation INTO the last real entry is NOT masked by the
  // tolerance: the chain then ends below the head sidecar, which reports it.
  const dir3 = freshDir();
  for (let i = 1; i <= 3; i++) appendAudit(dir3, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  const file3 = pathReal.join(dir3, 'audit.jsonl');
  const raw3 = fsReal.readFileSync(file3, 'utf8');
  fsReal.writeFileSync(file3, raw3.slice(0, raw3.lastIndexOf('"hash"'))); // cut seq 3 mid-line
  _resetAuditCache();
  const cut = verifyAudit(dir3);
  assert.equal(cut.ok, false, 'cutting into the last entry is caught');
  assert.match(cut.detail ?? '', /truncated/);

  // Torn tail on ANCHORS.jsonl: previously a permanent "anchors were tampered
  // with"; now tolerated by verify and healed by the next anchorHead.
  const dir4 = freshDir();
  for (let i = 1; i <= 3; i++) appendAudit(dir4, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  assert.ok(anchorHead(dir4), 'first anchor');
  const af = pathReal.join(dir4, 'anchors.jsonl');
  fsReal.appendFileSync(af, '{"seq":4,"ha');
  _resetAuditCache();
  assert.equal(verifyAudit(dir4).ok, true, 'a torn anchor line is not tampering');
  appendAudit(dir4, { principal: 'a', decision: 'call', server: 's', tool: 't4' });
  const a2 = anchorHead(dir4);
  assert.ok(a2 && a2.seq === 4, 'anchoring proceeds');
  assert.equal(readAnchors(dir4).length, 2, 'the torn line was truncated, not written past');
  assert.equal(verifyAudit(dir4).ok, true);
  // But a newline-terminated malformed anchor line is still tampering (gap 3).
  fsReal.appendFileSync(af, 'not json\n');
  _resetAuditCache();
  assert.equal(verifyAudit(dir4).ok, false);

  // Rotation with a torn tail heals first, so the archive never carries the fragment.
  const dir5 = freshDir();
  for (let i = 1; i <= 3; i++) appendAudit(dir5, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  fsReal.appendFileSync(pathReal.join(dir5, 'audit.jsonl'), '{"seq":4,"at":"2026');
  _resetAuditCache();
  const rot = rotateAudit(dir5);
  assert.equal(rot.ok, true, rot.detail);
  assert.ok(fsReal.readFileSync(pathReal.join(dir5, rot.archived!), 'utf8').endsWith('\n'), 'the archive ends on a complete entry');
  assert.equal(verifyAudit(dir5).ok, true);
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
    // The new live segment exists and starts with a real CHAINED marker (seq 5),
    // not an unauthenticated carry — so verify walks archive+live as one chain.
    assert.ok(fsReal.existsSync(pathReal.join(dir, 'audit.jsonl')), 'a fresh live segment with the boundary marker exists');
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, true, 'the rotated log verifies (archive + marker)');
    // The pre-rotation anchor is for seq 4, which lives in the ARCHIVE — verify
    // walks the archive to check it, never skips it.
    assert.equal(verifyAudit(dir, { against: [external] }).ok, true, 'the pre-rotation anchor is verified against the archived segment');

    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 'post0' });
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 'post1' });
    _resetAuditCache();
    const v = verifyAudit(dir, { against: [external] });
    assert.equal(v.ok, true, `the continued chain verifies: ${v.detail ?? ''}`);
    const seqs = readAudit(dir).map((e) => e.seq);
    assert.deepEqual(seqs, [5, 6, 7], 'the live segment is marker(5) + post0(6) + post1(7); seq is monotonic across the boundary');
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a forged rotation cannot make verify pass — the carry attack is closed (Fable pass-4 CRITICAL)', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
  try {
    for (let i = 0; i < 10; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    const a = anchorHead(dir)!;
    const offbox = [{ seq: a.seq, hash: a.hash }]; // the operator holds this off the box
    assert.equal(verifyAudit(dir, { against: offbox }).ok, true, 'clean log verifies against the off-box anchor');

    // The old attack: write a forged carry to raise the base, delete the log, and
    // verify would report clean. There is no carry now — forging one is inert —
    // and deleting the live log is caught as a deletion.
    fsReal.writeFileSync(pathReal.join(dir, 'audit.carry.json'), JSON.stringify({ seq: 900000, hash: 'f'.repeat(64) }));
    fsReal.unlinkSync(pathReal.join(dir, 'audit.jsonl'));
    fsReal.rmSync(pathReal.join(dir, 'head.json'), { force: true });
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, false, 'a deleted log is not "clean" just because a carry file was planted');
    assert.equal(verifyAudit(dir, { against: offbox }).ok, false, 'and the off-box anchor is NOT skipped — the forgery is caught');
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a rotated log detects a deleted or edited archive', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
  try {
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    const rot = rotateAudit(dir);
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 'post' });
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, true, 'baseline: rotated log verifies');
    // Edit the archive: verify walks it and catches the edit.
    const archive = pathReal.join(dir, rot.archived!);
    const al = fsReal.readFileSync(archive, 'utf8').split('\n').filter(Boolean);
    const e = JSON.parse(al[1]); e.tool = 'EVIL'; al[1] = JSON.stringify(e);
    fsReal.writeFileSync(archive, al.join('\n') + '\n');
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, false, 'an edited archive is caught (archives are walked, not trusted)');
    // Delete the archive entirely (no off-box anchor pins its boundary): fail.
    fsReal.unlinkSync(archive);
    _resetAuditCache();
    const v = verifyAudit(dir);
    assert.equal(v.ok, false, 'a deleted archive is caught');
    assert.match(v.detail ?? '', /not present|does not link|out of order/);
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a non-object JSON line (a bare null) is CHAIN BROKEN, not an uncaught throw (Fable-5)', () => {
  // JSON.parse("null") succeeds, so a naive parser skips the "not JSON" branch
  // and then throws a TypeError on the property access — which the daemon
  // swallows as "verify threw (ignored)", muting the alarm. verify must report a
  // broken chain instead, so an appended `null` is caught as tampering.
  const dir = freshDir();
  for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  fsReal.appendFileSync(pathReal.join(dir, 'audit.jsonl'), 'null\n');
  _resetAuditCache();
  let v: ReturnType<typeof verifyAudit>;
  assert.doesNotThrow(() => { v = verifyAudit(dir); }, 'verify must not throw on a non-object line');
  assert.equal(v!.ok, false, 'the null line breaks the chain');
  assert.match(v!.detail ?? '', /not a JSON object/);
});

test('a corrupted anchor line or a truncation below the shipped cursor is caught (red-team audit gap 3)', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null'; // ships each anchor, advancing the cursor
  try {
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    anchorHead(dir); // anchor #1, shipped
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't5' });
    anchorHead(dir); // anchor #2, shipped — cursor names it
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, true, 'the clean log verifies');
    const af = pathReal.join(dir, 'anchors.jsonl');
    const lines = fsReal.readFileSync(af, 'utf8').split('\n').filter(Boolean);
    // Corrupting the last anchor line reads like deleting it to the lenient reader;
    // strict parse treats it as tampering.
    fsReal.writeFileSync(af, lines.slice(0, -1).concat('this is not json').join('\n') + '\n');
    _resetAuditCache();
    const vCorrupt = verifyAudit(dir);
    assert.equal(vCorrupt.ok, false, 'a corrupted anchor line is tampering');
    assert.match(vCorrupt.detail ?? '', /malformed line|non-object line/);
    // Truncate the anchor log to a valid PREFIX (drop anchor #2) — but the shipped
    // cursor still names #2, which is now gone: a truncation below what was shipped.
    fsReal.writeFileSync(af, lines.slice(0, 1).join('\n') + '\n');
    _resetAuditCache();
    const vTrunc = verifyAudit(dir);
    assert.equal(vTrunc.ok, false, 'truncation below the shipped cursor is caught');
    assert.match(vTrunc.detail ?? '', /truncated below the shipped cursor/);
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('an off-box archive with an interior anchor still verifies after it is offloaded (Fable-5)', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
  try {
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    anchorHead(dir); // an INTERIOR anchor at seq 4, shipped off-box
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't5' });
    const rot = rotateAudit(dir); // anchors the head (seq 5) and archives seq 1-5
    assert.equal(rot.ok, true, rot.detail);
    // The operator holds the FULL off-box anchor chain (seq 4 interior + seq 5 boundary).
    const offbox = readAnchors(dir).map((a) => ({ seq: a.seq, hash: a.hash }));
    assert.ok(offbox.some((p) => p.seq === 4) && offbox.some((p) => p.seq === 5), 'both anchors were taken');
    // Offload the archive off the box, then verify against the full off-box chain,
    // NAMING the offloaded archive (the operator declares what they moved off-box;
    // an absent archive not named is a deletion — audit gap 1).
    fsReal.rmSync(pathReal.join(dir, rot.archived!));
    _resetAuditCache();
    const v = verifyAudit(dir, { against: offbox, offloaded: [rot.archived!] });
    assert.equal(v.ok, true, `a correctly-offloaded, NAMED archive must not false-alarm: ${v.detail ?? ''}`);
    // But the SAME off-box anchors without naming it is a deletion: pinning alone
    // is not consent (an attacker picks which anchor to fabricate a segment over).
    _resetAuditCache();
    const unnamed = verifyAudit(dir, { against: offbox });
    assert.equal(unnamed.ok, false, 'an absent archive that the operator did not declare offloaded is a deletion');
    assert.match(unnamed.detail ?? '', /not declared offloaded|--offloaded/);
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a declared offload keeps anchoring and rotation working; an undeclared deletion still alarms (Fable-6 #2)', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null'; // ships the boundary anchor off-box
  try {
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't5' });
    const rot = rotateAudit(dir); // archives seq 1-5, boundary anchor shipped
    assert.equal(rot.ok, true, rot.detail);
    const archive = rot.archived!;
    const offbox = readAnchors(dir).map((a) => ({ seq: a.seq, hash: a.hash }));

    // BEFORE the fix, simply deleting the archive off-box permanently broke the
    // on-box self-checks. Do it the SUPPORTED way: declare the offload.
    const off = offloadArchive(dir, archive);
    assert.equal(off.ok, true, `offload should succeed once the boundary anchor is shipped: ${off.detail ?? ''}`);
    assert.ok((off.freedBytes ?? 0) > 0, 'it reports the reclaimed space');
    assert.ok(!fsReal.existsSync(pathReal.join(dir, archive)), 'the local copy is removed');
    _resetAuditCache();

    // The whole point of #2: on-box anchoring and rotation still work after offload.
    for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `later${i}` });
    const a2 = anchorHead(dir);
    assert.ok(a2, 'anchoring is NOT permanently disabled by an offload');
    const rot2 = rotateAudit(dir);
    assert.equal(rot2.ok, true, `rotation is NOT permanently disabled by an offload: ${rot2.detail ?? ''}`);

    // The operator's authoritative check still re-verifies the offloaded range
    // against the REAL off-box anchor, and requires the operator to NAME the
    // offloaded archive — the declared flag alone does not satisfy it (audit gap 1).
    _resetAuditCache();
    const vAuth = verifyAudit(dir, { against: offbox, offloaded: [archive] });
    assert.equal(vAuth.ok, true, `authoritative verify with off-box anchors + named offload passes: ${vAuth.detail ?? ''}`);

    // And an UNDECLARED deletion of an on-box archive is still a hard failure, even
    // for the lenient liveness check — offload is a declaration, not a free pass.
    const seg2 = rot2.archived!;
    fsReal.rmSync(pathReal.join(dir, seg2));
    _resetAuditCache();
    const vLive = verifyAudit(dir, { trustDeclaredOffload: true });
    assert.equal(vLive.ok, false, 'an undeclared archive deletion still alarms');
    assert.match(vLive.detail ?? '', /not present|cannot be verified/);
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('offload refuses unless the boundary anchor has shipped off-box (Fable-6 #2)', () => {
  const dir = freshDir();
  // No off-box anchoring: rotate still works, but the boundary is not shipped, so
  // the range would become permanently unverifiable if the local copy were removed.
  for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  const rot = rotateAudit(dir);
  assert.equal(rot.ok, true, rot.detail);
  const off = offloadArchive(dir, rot.archived!);
  assert.equal(off.ok, false, 'offload is refused with no shipped boundary anchor');
  assert.match(off.detail ?? '', /anchor|ship/);
  assert.ok(fsReal.existsSync(pathReal.join(dir, rot.archived!)), 'the local archive is left in place');
});

test('the liveness bridge requires a SHIPPED boundary anchor, not just the offloaded flag (Fable-6 #2 follow-up)', () => {
  const dir = freshDir();
  // No off-box anchoring: rotate takes a LOCAL boundary anchor but ships nothing.
  for (let i = 0; i < 5; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
  const rot = rotateAudit(dir);
  assert.equal(rot.ok, true, rot.detail);
  // Forge: delete the archive and set offloaded:true in the manifest, WITHOUT ever
  // shipping the boundary anchor off-box. Even the lenient on-box liveness check
  // must refuse — the flag alone is not enough.
  fsReal.rmSync(pathReal.join(dir, rot.archived!));
  const segFile = pathReal.join(dir, 'audit.segments.jsonl');
  const segs = fsReal.readFileSync(segFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  segs[0].offloaded = true;
  fsReal.writeFileSync(segFile, segs.map((s) => JSON.stringify(s)).join('\n') + '\n');
  _resetAuditCache();
  const v = verifyAudit(dir, { trustDeclaredOffload: true });
  assert.equal(v.ok, false, 'a forged offloaded flag without a shipped boundary anchor is refused even by the liveness check');
  assert.match(v.detail ?? '', /no shipped off-box anchor|not present|cannot be verified/);
});

test('offload rejects a non-basename file and is idempotent on re-run (Fable-6 #2 follow-up)', () => {
  const dir = freshDir();
  // A path that could escape the audit dir is refused before any filesystem touch.
  for (const bad of ['../secrets', 'audit.jsonl', '/etc/passwd', 'audit.1-2.jsonl.bak']) {
    const r = offloadArchive(dir, bad);
    assert.equal(r.ok, false, `${bad} is not a valid archive name`);
    assert.match(r.detail ?? '', /not an archive filename/);
  }
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
  try {
    for (let i = 0; i < 5; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    const rot = rotateAudit(dir);
    assert.equal(rot.ok, true, rot.detail);
    const off1 = offloadArchive(dir, rot.archived!);
    assert.equal(off1.ok, true, off1.detail);
    // Re-running offload on an already-declared segment (local copy already gone) is
    // a no-op success, not an error — so an interrupted offload can be safely retried.
    _resetAuditCache();
    const off2 = offloadArchive(dir, rot.archived!);
    assert.equal(off2.ok, true, 'a re-run of an already-offloaded segment is idempotent');
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

test('with off-box anchoring configured, rotation refuses if the boundary anchor did not ship (M9)', () => {
  const dir = freshDir();
  // A ship command that always fails: the boundary anchor cannot be pinned
  // off-box, so archiving the live segment would make a later deletion of that
  // archive undetectable. Rotation must refuse rather than trade that away.
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'false';
  try {
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    const rot = rotateAudit(dir);
    assert.equal(rot.ok, false, 'rotation is refused when the boundary anchor did not ship');
    assert.match(rot.detail ?? '', /did not ship off-box/);
    assert.ok(fsReal.existsSync(pathReal.join(dir, 'audit.jsonl')), 'the live segment is left intact');
    assert.ok(!fsReal.existsSync(pathReal.join(dir, 'audit.segments.jsonl')), 'nothing was archived');

    // Once the ship command works, the same rotation goes through.
    process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
    _resetAuditCache();
    const rot2 = rotateAudit(dir);
    assert.equal(rot2.ok, true, rot2.detail);
    _resetAuditCache();
    assert.equal(verifyAudit(dir).ok, true, 'the rotated log still verifies');
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a forged spill file is never laundered into the chain (Fable-6 #7)', () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'alice', decision: 'call', server: 's', tool: 'real' });
  // An attacker with box write drops a spill file (for THIS process's pid, the
  // one foldSpills would read) with a fabricated row and a bogus HMAC.
  const spill = pathReal.join(dir, `audit.spill.${process.pid}.jsonl`);
  fsReal.writeFileSync(spill, JSON.stringify({ row: JSON.stringify({ principal: 'attacker', decision: 'allow', tool: 'FORGED', at: new Date().toISOString() }), hmac: 'not-a-valid-hmac' }) + '\n');
  // The next legitimate append folds spills first — the forged row must be
  // dropped (bad HMAC), not chained.
  appendAudit(dir, { principal: 'alice', decision: 'call', server: 's', tool: 'real2' });
  _resetAuditCache();
  const tools = readAudit(dir).map((e) => e.tool);
  assert.ok(!tools.includes('FORGED'), 'the forged spill row never entered the chain');
  assert.deepEqual(tools.filter((t) => t?.startsWith('real')), ['real', 'real2'], 'the real rows are intact');
  assert.equal(verifyAudit(dir).ok, true, 'and the chain verifies');
});

test('a lock squatter cannot silently drop, reorder, or delete spilled rows — the fold alarms on any discontinuity', () => {
  const dir = freshDir();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't0' });
  const lp = pathReal.join(dir, 'audit.lock');
  const spill = pathReal.join(dir, `audit.spill.${process.pid}.jsonl`);
  // Squat: an always-alive pid in the lock is never broken, so every append
  // spills. (Our own pid stands in for the attacker's `1:x`.)
  const squat = () => fsReal.writeFileSync(lp, `${process.pid}:squat`);
  const spillLines = () => fsReal.readFileSync(spill, 'utf8').split('\n').filter(Boolean);
  const tools = () => readAudit(dir).map((e) => e.tool).filter(Boolean);
  const alarms = () => readAudit(dir).filter((e) => e.decision === 'error' && e.principal === 'system').map((e) => e.reason ?? '');

  // 1. A DELETED middle row. Each surviving line still carries a valid MAC, so
  //    before the fix the fold chained s1 and s3 with fresh seqs and s2 was gone
  //    without a trace.
  squat();
  for (const t of ['s1', 's2', 's3']) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: t });
  const three = spillLines();
  assert.equal(three.length, 3, 'three rows spilled under the squat');
  fsReal.writeFileSync(spill, [three[0], three[2]].join('\n') + '\n');
  fsReal.unlinkSync(lp);
  const err1 = captureStderr(() => appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't4' }));
  assert.match(err1, /AUDIT ALARM/, 'the gap is loud on stderr');
  assert.deepEqual(tools(), ['t0', 's1', 's3', 't4'], 'the authentic survivors are still folded, in order — nothing else is lost');
  assert.equal(alarms().length, 1, 'and the gap is recorded IN the chain as a system error row');
  assert.match(alarms()[0], /spill discontinuity.*missing \[2\]/, 'naming the missing counter');

  // 2. REORDERED rows: the counters say which order is real.
  squat();
  for (const t of ['s5', 's6']) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: t });
  const two = spillLines();
  fsReal.writeFileSync(spill, [two[1], two[0]].join('\n') + '\n');
  fsReal.unlinkSync(lp);
  const err2 = captureStderr(() => appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't7' }));
  assert.match(err2, /AUDIT ALARM/);
  assert.deepEqual(tools().slice(-3), ['s5', 's6', 't7'], 'folded in counter order, not file order');
  assert.equal(alarms().length, 2);

  // 3. A DUPLICATED row is not folded twice.
  squat();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 's8' });
  const one = spillLines();
  fsReal.writeFileSync(spill, [one[0], one[0]].join('\n') + '\n');
  fsReal.unlinkSync(lp);
  captureStderr(() => appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't9' }));
  assert.deepEqual(tools().slice(-2), ['s8', 't9'], 'one copy of the duplicated row');
  assert.equal(alarms().length, 3);

  // 4. The whole spill file UNLINKED: previously "nothing to fold", silently.
  squat();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 's10' });
  fsReal.unlinkSync(spill);
  fsReal.unlinkSync(lp);
  const err4 = captureStderr(() => appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't11' }));
  assert.match(err4, /AUDIT ALARM.*is gone with 1 row/, 'a vanished spill file with rows outstanding alarms');
  assert.equal(alarms().length, 4);
  // The alarm fires once, not on every later fold forever.
  const quiet = captureStderr(() => appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't12' }));
  assert.doesNotMatch(quiet, /AUDIT ALARM/, 'a clean append after the alarm is quiet');
  assert.equal(alarms().length, 4);

  // The chain is intact throughout: alarms are chained rows, not corruption.
  assert.equal(verifyAudit(dir).ok, true);
  // And an honest spill-then-fold still raises nothing (the H1 path).
  squat();
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 's13' });
  fsReal.unlinkSync(lp);
  const honest = captureStderr(() => appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't14' }));
  assert.doesNotMatch(honest, /ALARM/, 'no false alarm on an untouched spill');
  assert.deepEqual(tools().slice(-2), ['s13', 't14']);
});

test('spill GC reclaims only a provably DEAD pid, never an unknown one (a live holder in another pid namespace)', () => {
  const dir = freshDir();
  const old = new Date(Date.now() - 10 * 60_000); // well past LOCK_STALE_MS * 4
  // ESRCH: a pid that does not exist HERE — indistinguishable from a live
  // process in another namespace on a shared volume. Must survive.
  const unknown = pathReal.join(dir, 'audit.spill.2147483646.jsonl');
  // An invalid pid is provably dead: nobody can ever fold it. May be reclaimed.
  const dead = pathReal.join(dir, 'audit.spill.0.jsonl');
  for (const f of [unknown, dead]) { fsReal.writeFileSync(f, '{"n":1,"row":"{}","hmac":"x"}\n'); fsReal.utimesSync(f, old, old); }
  appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: 't0' }); // takes the lock; folds; GCs
  assert.ok(fsReal.existsSync(unknown), "an 'unknown' pid's spill is left alone");
  assert.ok(!fsReal.existsSync(dead), "a 'dead' pid's stale spill is reclaimed");
});

test('rotation refuses when off-box anchoring was used but no anchor command is set now (Fable-6 #6)', () => {
  const dir = freshDir();
  try {
    // Anchoring was used before: a real anchor is taken and shipped, creating the
    // ship cursor legitimately.
    process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null';
    for (let i = 0; i < 4; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `t${i}` });
    anchorHead(dir);
    assert.ok(fsReal.existsSync(pathReal.join(dir, 'anchors.shipped')), 'a ship cursor now exists');
    // The operator now rotates from a shell WITHOUT the command — the boundary
    // could not ship, so refuse rather than silently skip the guard.
    delete process.env.CAIRN_AUDIT_ANCHOR_CMD;
    const rot = rotateAudit(dir);
    assert.equal(rot.ok, false, 'rotation is refused');
    assert.match(rot.detail ?? '', /off-box anchoring is in use/);
    assert.ok(fsReal.existsSync(pathReal.join(dir, 'audit.jsonl')), 'the live segment is left intact');
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a rewritten manifest record cannot stretch a declared offload over deleted archives (range rewrite)', () => {
  const dir = freshDir();
  process.env.CAIRN_AUDIT_ANCHOR_CMD = 'cat > /dev/null'; // every boundary anchor ships
  try {
    // Three rotations: three archives, each boundary anchored and shipped.
    const archives: string[] = [];
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 3; i++) appendAudit(dir, { principal: 'a', decision: 'call', server: 's', tool: `r${r}t${i}` });
      const rot = rotateAudit(dir);
      assert.equal(rot.ok, true, rot.detail);
      archives.push(rot.archived!);
    }
    // The FIRST archive is offloaded the supported way — a genuine declared bridge.
    const off = offloadArchive(dir, archives[0]);
    assert.equal(off.ok, true, off.detail);
    const offbox = readAnchors(dir).map((a) => ({ seq: a.seq, hash: a.hash }));
    _resetAuditCache();
    assert.equal(verifyAudit(dir, { trustDeclaredOffload: true }).ok, true, 'the honest state passes the liveness check');
    assert.equal(verifyAudit(dir, { against: offbox, offloaded: [archives[0]] }).ok, true, 'and the authoritative one');

    // ATTACK (box write): keep the offloaded record's filename, but stretch its
    // lastSeq/lastHash to the LAST archive's real, shipped boundary; drop the two
    // later records and delete their archives. Before the fix, both verifies
    // bridged the whole range as one declared offload — two archives of history
    // gone, no alarm, and the daemon's filename-keyed guard saw nothing novel.
    const segFile = pathReal.join(dir, 'audit.segments.jsonl');
    const segs = fsReal.readFileSync(segFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(segs.length, 3);
    const stretched = { ...segs[0], lastSeq: segs[2].lastSeq, lastHash: segs[2].lastHash };
    fsReal.writeFileSync(segFile, JSON.stringify(stretched) + '\n');
    fsReal.rmSync(pathReal.join(dir, archives[1]));
    fsReal.rmSync(pathReal.join(dir, archives[2]));
    _resetAuditCache();
    const live = verifyAudit(dir, { trustDeclaredOffload: true });
    assert.equal(live.ok, false, 'the liveness check refuses the stretched record');
    assert.match(live.detail ?? '', /filename does not encode|manifest was rewritten/);
    const auth = verifyAudit(dir, { against: offbox, offloaded: [archives[0]] });
    assert.equal(auth.ok, false, 'the authoritative check refuses it too, even with the real off-box anchors and the operator naming the offload');
    assert.match(auth.detail ?? '', /filename does not encode|manifest was rewritten/);
  } finally { delete process.env.CAIRN_AUDIT_ANCHOR_CMD; }
});

test('a write failure never throws out of appendAudit (a broken log must not break a call)', () => {
  // Point the audit dir at a path whose parent is a file, so mkdir/append fail.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-audit-'));
  const asFile = path.join(base, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  _resetAuditCache();
  assert.doesNotThrow(() => appendAudit(path.join(asFile, 'audit'), { principal: 'a', decision: 'call' }));
});
