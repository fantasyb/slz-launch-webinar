/**
 * The commitment must bind the field VALUES, not merely some string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCommitment, canonicalPreimage } from '../src/lib/cairn/commitment';

const base = {
  findingId: 'cairn-0001',
  by: 'alice',
  priorConfirmed: 0.9,
  reasoning: 'because the proxy allowlists hosts',
  anchor: 'deadbee',
  nonce: 'AAAAAAAAAAAAAAAA',
};

test('a field containing the old separator cannot move a field boundary', () => {
  // The v1 encoding joined fields with U+001F and asserted the separator could
  // not occur in any field. `by` and `reasoning` are free text, so it could.
  // These two are both valid predictions and hashed identically, which let a
  // predictor seal once and reveal either a 0.9 or a 0.5 prior.
  const S = String.fromCharCode(31);
  const a = { ...base, priorConfirmed: 0.9, reasoning: `R${S}0.5000${S}BBBBBBBBBBBBBBBB` };
  const b = {
    ...base,
    by: `alice${S}0.9000${S}R`,
    priorConfirmed: 0.5,
    reasoning: 'BBBBBBBBBBBBBBBB',
  };
  assert.notEqual(computeCommitment(a), computeCommitment(b));
});

test('the encoding is injective over adversarial field values', () => {
  const nasty = ['', 'a', '"', '\\', '","', '\n', ' ', '\u{1F600}', 'ue', String.fromCharCode(31)];
  const seen = new Map();
  for (const by of nasty) {
    for (const reasoning of nasty) {
      const key = canonicalPreimage({ ...base, by, reasoning });
      const id = JSON.stringify([by, reasoning]);
      const clash = seen.get(key);
      assert.equal(clash, undefined, `collision between ${clash} and ${id}`);
      seen.set(key, id);
    }
  }
});

test('whitespace around the reasoning is part of what was sealed', () => {
  // v1 trimmed inside the preimage, so a sealed "why" and a revealed "  why  "
  // hashed the same and the revealed text need not be the sealed text.
  assert.notEqual(
    computeCommitment({ ...base, reasoning: 'why' }),
    computeCommitment({ ...base, reasoning: '  why  ' }),
  );
});

test('a lone surrogate does not collide with the replacement character', () => {
  assert.notEqual(
    computeCommitment({ ...base, reasoning: '\uD800' }),
    computeCommitment({ ...base, reasoning: '\uFFFD' }),
  );
});
