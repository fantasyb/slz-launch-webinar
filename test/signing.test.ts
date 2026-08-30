/**
 * What a signature actually covers.
 *
 * Each case here is a field an author could change after signing while every
 * signature still verified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingBodyHash } from '../src/lib/cairn/signing';
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
