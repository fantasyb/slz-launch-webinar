/**
 * Resonance: a finding with a signature fires only when the live result shows
 * the trap manifesting — silent, and free, on every other call. A finding
 * without one rings on its tool alone, as it always did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resonates, isValidSignature } from '../src/lib/cairn/resonance';

/* The real fixture traps' result shapes, so the signatures are tested against
 * the exact text the tool returns. */
const STALE_EMPTY = '{"status":"success","records":[]}';
const HEALTHY = '{"status":"success","records":[{"id":"001"},{"id":"002"}]}';

test('no signature: rings on the tool alone (legacy behaviour preserved)', () => {
  assert.equal(resonates({}, STALE_EMPTY), true);
  assert.equal(resonates({}, HEALTHY), true);
  assert.equal(resonates({ signature: undefined }, ''), true);
});

test('a signature fires only on the result that resonates', () => {
  const staleMapping = { signature: '"records"\\s*:\\s*\\[\\]' };
  assert.equal(resonates(staleMapping, STALE_EMPTY), true, 'rings on the empty-success trap');
  assert.equal(resonates(staleMapping, HEALTHY), false, 'silent when records are present');
});

test('dormant on the calls that never hit the trap', () => {
  const sig = { signature: 'CONNECT tunnel failed, response 403' };
  assert.equal(resonates(sig, 'curl: (56) CONNECT tunnel failed, response 403'), true);
  assert.equal(resonates(sig, 'HTTP/2 200 OK'), false);
  assert.equal(resonates(sig, ''), false);
});

test('a broken signature is dormant, never a crash and never blind firing', () => {
  const bad = { signature: '([unclosed' };
  assert.equal(isValidSignature('([unclosed'), false);
  assert.equal(resonates(bad, STALE_EMPTY), false, 'an uncompilable pattern never fires');
});

test('the match is capped, so a huge result cannot stall the fork', () => {
  const sig = { signature: 'needle' };
  const haystack = 'x'.repeat(50_000) + 'needle'; // past the 20k cap
  assert.equal(resonates(sig, haystack), false, 'past the cap it does not match — bounded, not unbounded work');
  assert.equal(resonates(sig, 'needle' + 'x'.repeat(50_000)), true, 'within the cap it matches');
});

test('isValidSignature accepts real patterns, rejects garbage', () => {
  assert.equal(isValidSignature('"total_count"\\s*:\\s*0'), true);
  assert.equal(isValidSignature('rows returned: \\d+'), true);
  assert.equal(isValidSignature('('), false);
});
