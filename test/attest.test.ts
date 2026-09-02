/**
 * Freshness that is real: an observation from whoever just used the tool,
 * and a line that says what a standing rests on -- so "verified by a check
 * yesterday" and "asserted once, never re-run" never read the same.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-attest-test-'));
fs.mkdirSync(path.join(home, 'cairn'));
process.env.CAIRN_HOME = home;

function plant(id: string, patch: Record<string, unknown>): string {
  const donor = JSON.parse(fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'));
  const file = path.join(home, 'cairn', `${id.slice(6)}-t.json`);
  fs.writeFileSync(file, JSON.stringify({ ...donor, id, title: `finding ${id}`, predictions: [], ...patch }));
  return file;
}

test('a verification line says what the standing rests on, and whether a machine could re-run the check', async () => {
  const { verification, verificationLine } = await import('../src/lib/cairn/attest');
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const f = FindingSchema.parse(JSON.parse(fs.readFileSync(plant('cairn-0101', {
    check: { command: 'Look at it by hand.', confirmedIf: 'x', refutedIf: 'y', manual: true },
    observations: [{ at: old, by: 'joey.ahern', verdict: 'confirmed' }],
  }), 'utf8')));
  const v = verification(f);
  assert.equal(v.source, 'attested');
  assert.equal(v.checkable, false);
  assert.equal(v.due, true, 'twenty days without a confirmation is due');
  assert.match(verificationLine(f), /attested by joey\.ahern 20 days ago, not by a check; check is manual: no machine can re-run it/);

  const m = FindingSchema.parse(JSON.parse(fs.readFileSync(plant('cairn-0102', {
    check: { command: 'test -f /nope', confirmedIf: 'x', refutedIf: 'y', manual: false },
    observations: [{ at: new Date().toISOString(), by: 'doctor', verdict: 'confirmed', note: 'cairn:doctor: exit 0' }],
  }), 'utf8')));
  assert.equal(verification(m).source, 'machine');
  assert.match(verificationLine(m), /verified by its check today; check runnable/);
});

test('an observation from the gateway is appended unsigned, and a refutation without a reason is refused', async () => {
  const { attest } = await import('../src/lib/cairn/attest');
  const file = plant('cairn-0103', { observations: [{ at: '2026-08-01T00:00:00.000Z', by: 'someone', verdict: 'confirmed' }] });
  const bare = attest({ finding: 'cairn-0103', verdict: 'refuted' }, { by: 'agent-x' });
  assert.equal(bare.ok, false);
  assert.match(bare.message, /needs a note/);
  const r = attest({ finding: 'cairn-0103', verdict: 'refuted', note: 'the call returned the rows the finding says it cannot' }, { by: 'agent-x', via: 'test' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Recorded refuted on cairn-0103 by agent-x; it now stands (stale|aging)\./, 'unsigned: recorded, shown, but the standing does not move');
  assert.match(r.message, /does not move its standing; give the gateway a key/);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.observations.length, 2);
  assert.equal(stored.observations[1].verdict, 'refuted');
  assert.equal(stored.observations[1].signature, undefined, 'unsigned, like a finding recorded through cairn_record');
  assert.match(stored.observations[1].environment.note, /via test/);
  const c = attest({ finding: 'cairn-0103', verdict: 'confirmed' }, { by: 'agent-y' });
  assert.equal(c.ok, true);
  assert.equal(attest({ finding: 'cairn-9999', verdict: 'confirmed' }, { by: 'x' }).ok, false, 'an unknown id is refused');
  assert.equal(attest({ finding: 'not-an-id', verdict: 'confirmed' }, { by: 'x' }).ok, false);
});

test('given a key, the gateway signs, and a signed refutation makes the finding contested', async () => {
  const { attest, verificationLine } = await import('../src/lib/cairn/attest');
  const { generateKeypair } = await import('../src/lib/cairn/signing');
  const { record, privateKey } = generateKeypair('pilot-gateway');
  fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(home, 'keys', `${record.keyId}.json`), JSON.stringify(record));
  fs.mkdirSync(path.join(home, '.cairn-secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cairn-secrets', `${record.keyId}.key`), privateKey);
  const file = plant('cairn-0104', { observations: [{ at: new Date().toISOString(), by: 'someone', verdict: 'confirmed' }] });
  const r = attest({ finding: 'cairn-0104', verdict: 'refuted', note: 'the call returned rows through the default mapping' }, { by: 'claude-code', keyId: record.keyId });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /by pilot-gateway; it now stands contested\. Signed by/);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.observations[1].by, 'pilot-gateway', 'signed under the key\'s label, not the client\'s name');
  assert.equal(stored.observations[1].signature.keyId, record.keyId);
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  assert.match(verificationLine(FindingSchema.parse(stored)), /contested .*1 refutation on record/);
});
