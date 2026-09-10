/**
 * THE CULL WIRE. An agent's `cairn_observe refuted` must be able to move a
 * finding's standing — the agent that re-uses a finding is the only observer
 * most findings will ever have — WITHOUT that observation ever making the
 * finding's check executable (red-team creative #2: hostile upstream → model
 * records a malicious check.command → model self-signs → doctor runs it).
 *
 * Both halves are pinned here, against the same stored observation:
 *   (a) an agent-origin observation signed by the gateway key contests the
 *       finding and drops its confidence to zero;
 *   (b) that same observation is NOT operator promotion — isOperatorPromoted
 *       stays false — and stripping the attest-only marker off it breaks the
 *       signature rather than upgrading it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
/* signing.ts reads no corpus home at import time, so it is safe to import before CAIRN_HOME is set. */
import { generateKeypair } from '../src/lib/cairn/signing';

const REPO = process.cwd();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cull-wire-'));
fs.mkdirSync(path.join(home, 'cairn'));
fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
fs.mkdirSync(path.join(home, '.cairn-secrets'), { recursive: true });
process.env.CAIRN_HOME = home;

/* Two keys: the operator's (a person at the CLI) and the gateway's (the one a
 * model's observations are signed attest-only under). Written before any
 * import so loadKeys() memoises a map that has both. */
const operator = generateKeypair('operator');
const gateway = generateKeypair('pilot-gateway');
for (const k of [operator, gateway]) {
  fs.writeFileSync(path.join(home, 'keys', `${k.record.keyId}.json`), JSON.stringify(k.record));
  fs.writeFileSync(path.join(home, '.cairn-secrets', `${k.record.keyId}.key`), k.privateKey);
}

function plant(id: string, patch: Record<string, unknown>): string {
  const donor = JSON.parse(fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'));
  const file = path.join(home, 'cairn', `${id.slice(6)}-t.json`);
  fs.writeFileSync(file, JSON.stringify({ ...donor, id, title: `finding ${id}`, predictions: [], observations: [], ...patch }));
  return file;
}
/* An agent-recorded finding as cairn_record writes it: unsigned founding
 * confirmation, agentRecorded, a runnable check nobody has vouched for. */
const agentFinding = (id: string) =>
  plant(id, {
    agentRecorded: true,
    visibility: 'private',
    check: { command: 'test -f /tmp/planted', confirmedIf: 'x', refutedIf: 'y', manual: false },
    observations: [{ at: '2026-08-20T00:00:00.000Z', by: 'tenant-alice', verdict: 'confirmed', environment: { os: 'linux', arch: 'x64', runtime: 'node 22' } }],
  });

test('(a) an agent refutation signed attest-only by the gateway key contests the finding and zeroes its confidence', async () => {
  const { attest } = await import('../src/lib/cairn/attest');
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const { standing, confidence, disagreement } = await import('../src/lib/cairn/decay');
  const { reloadKeys } = await import('../src/lib/cairn/keys');
  const file = agentFinding('cairn-0201');
  const before = FindingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(standing(before, new Date(), reloadKeys()), 'aging', 'born aging: one unsigned confirmation, one environment');

  const r = attest(
    { finding: 'cairn-0201', verdict: 'refuted', note: 'the call returned the rows the finding says it cannot' },
    { by: 'claude-in-session', origin: 'agent', via: 'test gateway', keyId: gateway.record.keyId },
  );
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Signed attest-only by/, 'the reply says what kind of signature it is');
  assert.match(r.message, /it now stands contested/, 'and that the finding is now contested');
  assert.match(r.message, /never makes the check executable/);

  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const obs = stored.observations[1];
  assert.equal(obs.by, 'pilot-gateway', 'signed under the gateway key label, like every signed observation');
  assert.equal(obs.attestOnly, true, 'marked attest-only');
  assert.equal(obs.signature.keyId, gateway.record.keyId);

  const f = FindingSchema.parse(stored);
  const keys = reloadKeys();
  assert.equal(disagreement(f, new Date(), keys).refuters, 1, 'the attest-only signer is a party');
  assert.equal(standing(f, new Date(), keys), 'contested');
  assert.equal(confidence(f, new Date(), keys), 0, 'a contested finding scores zero, so it ranks below everything');
});

test('(b) that same attest-only observation is NOT operator promotion: the check stays un-executable', async () => {
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const { isOperatorPromoted } = await import('../src/lib/cairn/confirm');
  const { reloadKeys } = await import('../src/lib/cairn/keys');
  const file = path.join(home, 'cairn', '0201-t.json');
  const f = FindingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(f.observations.length, 2, 'the refutation from (a) is on the finding');
  assert.ok(f.observations[1].signature, 'and it is signed');
  assert.equal(isOperatorPromoted(f, reloadKeys()), false, 'red-team #2 stays shut: a signed attest-only observation does not promote the check into execution');
});

test('stripping the attest-only marker breaks the signature instead of upgrading it to promotion', async () => {
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const { isOperatorPromoted } = await import('../src/lib/cairn/confirm');
  const { standing, disagreement } = await import('../src/lib/cairn/decay');
  const { verifyObservation, bodyHashForObservation } = await import('../src/lib/cairn/signing');
  const { reloadKeys } = await import('../src/lib/cairn/keys');
  const stored = JSON.parse(fs.readFileSync(path.join(home, 'cairn', '0201-t.json'), 'utf8'));
  delete stored.observations[1].attestOnly; // an attacker with file write tries to launder attest-only into promotion
  const f = FindingSchema.parse(stored);
  const keys = reloadKeys();
  assert.equal(verifyObservation(f.id, f.observations[1], keys, bodyHashForObservation(f, f.observations[1])), 'broken', 'the marker is inside the signed bytes');
  assert.equal(isOperatorPromoted(f, keys), false, 'so it does not promote');
  assert.equal(disagreement(f, new Date(), keys).refuters, 0, 'and, broken, it no longer counts as a party either — the edit buys nothing in either direction');
  assert.notEqual(standing(f, new Date(), keys), 'contested');
});

test('adding the marker to a real operator signature breaks it too; an honest operator signature still promotes', async () => {
  const { attest } = await import('../src/lib/cairn/attest');
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const { isOperatorPromoted } = await import('../src/lib/cairn/confirm');
  const { reloadKeys } = await import('../src/lib/cairn/keys');
  const file = agentFinding('cairn-0202');
  /* The operator, at the CLI (no origin:'agent'), vouches for it. */
  const r = attest({ finding: 'cairn-0202', verdict: 'confirmed', note: 'ran it by hand, the check is honest' }, { by: 'operator', keyId: operator.record.keyId });
  assert.equal(r.ok, true, r.message);
  assert.doesNotMatch(r.message, /attest-only/);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.observations[1].attestOnly, undefined, 'an operator signature carries no attest-only marker');
  assert.equal(isOperatorPromoted(FindingSchema.parse(stored), reloadKeys()), true, 'a verifying operator signature promotes');

  const forged = JSON.parse(JSON.stringify(stored));
  forged.observations[1].attestOnly = true;
  const { verifyObservation, bodyHashForObservation } = await import('../src/lib/cairn/signing');
  const ff = FindingSchema.parse(forged);
  assert.equal(verifyObservation(ff.id, ff.observations[1], reloadKeys(), bodyHashForObservation(ff, ff.observations[1])), 'broken');
  assert.equal(isOperatorPromoted(ff, reloadKeys()), false);
});

test('a signature-shaped object that does not verify never promotes (presence was the old test)', async () => {
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const { isOperatorPromoted } = await import('../src/lib/cairn/confirm');
  const { reloadKeys } = await import('../src/lib/cairn/keys');
  const file = agentFinding('cairn-0203');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.observations.push({
    at: '2026-08-21T00:00:00.000Z', by: 'operator', verdict: 'confirmed',
    signature: { algorithm: 'ed25519', keyId: operator.record.keyId, value: Buffer.from('not a real signature at all, sixty-four bytes of nothing.........').toString('base64') },
  });
  assert.equal(isOperatorPromoted(FindingSchema.parse(stored), reloadKeys()), false, 'three schema-shaped strings do not make a check executable');
});

test('without a key the agent observation is still unsigned and moves nothing (the old behaviour, unchanged)', async () => {
  const { attest } = await import('../src/lib/cairn/attest');
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const { standing } = await import('../src/lib/cairn/decay');
  const { reloadKeys } = await import('../src/lib/cairn/keys');
  const file = agentFinding('cairn-0204');
  const r = attest({ finding: 'cairn-0204', verdict: 'refuted', note: 'the call returned rows it should not' }, { by: 'claude-in-session', origin: 'agent', via: 'test' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /does not move its standing; give the gateway a key/);
  const f = FindingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(f.observations[1].signature, undefined);
  assert.equal(f.observations[1].attestOnly, undefined, 'the marker is only ever set on a signed observation');
  assert.equal(standing(f, new Date(), reloadKeys()), 'aging');
});

test('the standalone server path (origin agent, no principal) still refuses a reserved by', async () => {
  const { attest } = await import('../src/lib/cairn/attest');
  agentFinding('cairn-0205');
  const r = attest({ finding: 'cairn-0205', verdict: 'confirmed', by: 'doctor' }, { origin: 'agent', via: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.message, /reserved signing identity/);
  const r2 = attest({ finding: 'cairn-0205', verdict: 'confirmed', by: 'operator' }, { origin: 'agent', via: 'test' });
  assert.equal(r2.ok, false, 'a local key label is reserved too');
  /* But the same label IS accepted when it is being signed under that key. */
  const r3 = attest({ finding: 'cairn-0205', verdict: 'confirmed', by: 'operator' }, { keyId: operator.record.keyId });
  assert.equal(r3.ok, true, r3.message);
});
