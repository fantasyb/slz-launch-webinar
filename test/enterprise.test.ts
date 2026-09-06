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
import {
  authenticate, authorize, tokenHash, bearerToken, LOCAL_ADMIN,
  appendAudit, verifyAudit, readAudit, _resetAuditCache,
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

test('a write failure never throws out of appendAudit (a broken log must not break a call)', () => {
  // Point the audit dir at a path whose parent is a file, so mkdir/append fail.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-audit-'));
  const asFile = path.join(base, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  _resetAuditCache();
  assert.doesNotThrow(() => appendAudit(path.join(asFile, 'audit'), { principal: 'a', decision: 'call' }));
});
