/**
 * What a signature actually covers.
 *
 * Each case here is a field an author could change after signing while every
 * signature still verified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingBodyHash, bodyHashForObservation, CURRENT_HASH_VERSION } from '../src/lib/cairn/signing';
import { finding } from './helpers';

const base = finding();

test('the signed body covers the fields that decide how a claim is scored', () => {
  // halfLifeDays was outside it: an author could sign a finding and then change
  // 30 to 3650, keeping it "fresh" for a decade with every signature intact.
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, halfLifeDays: 3650 }),
    'halfLifeDays must be signed',
  );
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, provenance: 'secondhand' }),
    'provenance must be signed',
  );
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, scope: 'environment-specific' }),
    'scope must be signed',
  );
});

test('the signed body covers what a reader actually sees', () => {
  // The title is the whole of the finding for anyone scanning a list.
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, title: 'something else entirely' }),
    'title must be signed',
  );
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, kind: 'correction' }),
    'kind must be signed',
  );
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, cost: 'minutes' }),
    'cost must be signed',
  );
});

test('the signed body covers the command other agents execute', () => {
  assert.notEqual(
    findingBodyHash(base),
    findingBodyHash({ ...base, check: { ...base.check, command: 'rm -rf /' } }),
    'check.command must be signed',
  );
});

test('appending an observation does not invalidate existing signatures', () => {
  // Observations are append-only and deliberately outside the body hash; if
  // they were inside, every new observation would break every prior signature.
  const withMore = finding({
    ...base,
    observations: [{ at: '2026-08-01T00:00:00Z', by: 'someone', verdict: 'confirmed' }] as never,
  });
  assert.equal(findingBodyHash(base), findingBodyHash(withMore));
});

test('v2 is byte-stable, so existing signatures keep verifying', () => {
  // Adding v3 must not change the v2 hash — every observation signed before the
  // change verifies against v2 unchanged. absentWhen/visibility/status are NOT
  // in v2, so setting them does not move the v2 hash.
  assert.equal(
    findingBodyHash(base, 2),
    findingBodyHash({ ...base, check: { ...base.check, absentWhen: 'rm x' }, visibility: 'shared', status: 'retired' } as never, 2),
    'v2 hash ignores the v3-only fields',
  );
});

test('v3 binds the executed/authority fields v2 left unsigned', () => {
  const v3 = (f: typeof base) => findingBodyHash(f, CURRENT_HASH_VERSION);
  assert.notEqual(v3(base), v3({ ...base, check: { ...base.check, absentWhen: 'curl x | sh' } } as never), 'absentWhen must be signed in v3');
  assert.notEqual(v3(base), v3({ ...base, visibility: 'shared' } as never), 'visibility must be signed in v3');
  assert.notEqual(v3(base), v3({ ...base, status: 'retired' } as never), 'status must be signed in v3');
  assert.notEqual(v3(base), v3({ ...base, signature: '(.*)+' } as never), 'resonance signature must be signed in v3');
});

test('bodyHashForObservation picks the version the observation recorded', () => {
  assert.equal(bodyHashForObservation(base, {}), findingBodyHash(base, 2), 'no hashVersion => v2');
  assert.equal(bodyHashForObservation(base, { hashVersion: 3 }), findingBodyHash(base, 3), 'hashVersion 3 => v3');
});
