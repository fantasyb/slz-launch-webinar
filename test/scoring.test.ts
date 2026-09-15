/**
 * Regression tests for the scoring invariants.
 *
 * Every case here is a defect that reached the corpus and was found by review
 * rather than by anything in the code. The point of the file is that the next
 * one gets found by the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confidence,
  standing,
  disagreement,
  derivedVerdict,
  effectiveEnvironments,
  signedEnvironmentCount,
  environmentCount,
  latestObservation,
} from '../src/lib/cairn/decay';
import { makeKey, keyMap, env, finding, signedFinding } from './helpers';

const A = makeKey('alice');
const B = makeKey('bob');
const C = makeKey('carol');
const D = makeKey('dave');
const KEYS = keyMap(A, B, C, D);

const NOW = new Date('2026-08-30T00:00:00Z');

test('an unsigned refutation cannot move confidence or standing', () => {
  const specs = [
    { key: A, obs: { at: '2026-08-28T00:00:00Z', by: 'alice', verdict: 'confirmed' as const, environment: env('linux') } },
    { key: B, obs: { at: '2026-08-29T00:00:00Z', by: 'bob', verdict: 'confirmed' as const, environment: env('darwin') } },
  ];
  const clean = signedFinding(specs);
  const withNoise = signedFinding([
    ...specs,
    { obs: { at: '2026-08-29T12:00:00Z', by: 'anyone-at-all', verdict: 'refuted' as const } },
  ]);
  assert.equal(confidence(withNoise, NOW, KEYS), confidence(clean, NOW, KEYS));
  assert.equal(standing(withNoise, NOW, KEYS), standing(clean, NOW, KEYS));
  assert.deepEqual(disagreement(withNoise, NOW, KEYS).refuters, 0);
});

test('a signed refutation does contest, and clears only at two distinct later signers', () => {
  const contested = signedFinding([
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
  ]);
  assert.equal(standing(contested, NOW, KEYS), 'contested');
  assert.equal(confidence(contested, NOW, KEYS), 0);

  const oneAnswer = signedFinding([
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
    { key: C, obs: { at: '2026-08-27T00:00:00Z', by: 'carol', verdict: 'confirmed', environment: env('darwin') } },
  ]);
  assert.equal(standing(oneAnswer, NOW, KEYS), 'contested', 'one confirmation must not clear a refutation');

  const cleared = signedFinding([
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
    { key: C, obs: { at: '2026-08-27T00:00:00Z', by: 'carol', verdict: 'confirmed', environment: env('darwin') } },
    { key: D, obs: { at: '2026-08-28T00:00:00Z', by: 'dave', verdict: 'confirmed', environment: env('win32') } },
  ]);
  assert.notEqual(standing(cleared, NOW, KEYS), 'contested');
  assert.ok(confidence(cleared, NOW, KEYS) > 0);
});

test('a confirmation before the refutation does not help clear it', () => {
  const f = signedFinding([
    { key: A, obs: { at: '2026-08-20T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: C, obs: { at: '2026-08-21T00:00:00Z', by: 'carol', verdict: 'confirmed', environment: env('darwin') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
  ]);
  assert.equal(disagreement(f, NOW, KEYS).confirmers, 0);
  assert.equal(standing(f, NOW, KEYS), 'contested');
});

test('future-dated observations contribute nothing, in either direction', () => {
  const base = [
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed' as const, environment: env('linux') } },
  ];
  // A future refutation must not contest, and must not do so permanently.
  const futureRefutation = signedFinding([
    ...base,
    { key: B, obs: { at: '2099-01-01T00:00:00Z', by: 'bob', verdict: 'refuted' as const } },
  ]);
  assert.notEqual(standing(futureRefutation, NOW, KEYS), 'contested');
  assert.ok(confidence(futureRefutation, NOW, KEYS) > 0);

  // Future confirmations must not clear a real refutation.
  const futureClear = signedFinding([
    ...base,
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' as const } },
    { key: C, obs: { at: '2099-01-01T00:00:00Z', by: 'carol', verdict: 'confirmed' as const, environment: env('darwin') } },
    { key: D, obs: { at: '2099-01-01T00:00:00Z', by: 'dave', verdict: 'confirmed' as const, environment: env('win32') } },
  ]);
  assert.equal(standing(futureClear, NOW, KEYS), 'contested');

  // And they buy no breadth.
  const futureBreadth = signedFinding([
    ...base,
    { key: B, obs: { at: '2099-01-01T00:00:00Z', by: 'bob', verdict: 'confirmed' as const, environment: env('darwin') } },
  ]);
  assert.equal(environmentCount(futureBreadth, NOW), 1);
});

test('one signer cannot manufacture breadth from many claimed environments', () => {
  const many = signedFinding(
    Array.from({ length: 5 }, (_, i) => ({
      key: A,
      obs: { at: '2026-08-29T00:00:00Z', by: 'alice', verdict: 'confirmed' as const, environment: env(`fake-${i}`) },
    })),
  );
  assert.equal(signedEnvironmentCount(many, KEYS, NOW), 1, 'capped at distinct signers');
  assert.equal(
    effectiveEnvironments(many, KEYS, NOW),
    1,
    'capped-off environments must not re-enter at half weight',
  );
});

test('unsigned environments are capped too, so fabricated breadth is not worth more than honest breadth', () => {
  const fabricated = finding({
    observations: Array.from({ length: 8 }, (_, i) => ({
      at: '2026-08-29T00:00:00Z',
      by: 'solo',
      verdict: 'confirmed',
      environment: env(`fake-${i}`),
    })) as never,
  });
  const honest = finding({
    observations: [
      { at: '2026-08-29T00:00:00Z', by: 'solo', verdict: 'confirmed', environment: env('linux') },
    ] as never,
  });
  assert.equal(
    effectiveEnvironments(fabricated, KEYS, NOW),
    effectiveEnvironments(honest, KEYS, NOW),
    'eight invented environments from one author must be worth exactly one',
  );
});

test('unsigned evidence cannot resolve a forecast', () => {
  // Consistent with every other aggregate: an unattributable observation
  // moves nothing. A forecast sealed against a corpus of unsigned reports
  // stays unresolved rather than being scored against nobody's word.
  const unsigned = finding({
    observations: [{ at: '2026-08-20T00:00:00Z', by: 'author', verdict: 'confirmed' }] as never,
  });
  assert.equal(
    derivedVerdict(unsigned, { since: new Date('2026-08-10T00:00:00Z'), asOf: NOW }),
    'inconclusive',
  );
});

test('derivedVerdict resolves only from evidence inside the window', () => {
  const f = signedFinding([
    { key: A, obs: { at: '2026-08-01T00:00:00Z', by: 'alice', verdict: 'confirmed' } },
    { key: A, obs: { at: '2026-08-20T00:00:00Z', by: 'alice', verdict: 'confirmed' } },
  ]);
  // A seal after all existing evidence resolves to nothing.
  assert.equal(derivedVerdict(f, { since: new Date('2026-08-25T00:00:00Z') }, KEYS), 'inconclusive');
  // A seal before the later observation resolves from it.
  assert.equal(
    derivedVerdict(f, { since: new Date('2026-08-10T00:00:00Z'), asOf: NOW }, KEYS),
    'confirmed',
  );
  // asOf excludes evidence recorded after the resolution.
  assert.equal(
    derivedVerdict(f, { since: new Date('2026-08-10T00:00:00Z'), asOf: new Date('2026-08-15T00:00:00Z') }, KEYS),
    'inconclusive',
  );
});

test('latestObservation does not throw on a finding with no observations', () => {
  assert.equal(latestObservation(finding()), undefined);
});

test('a forged signature buys nothing', () => {
  // partyOf returned an identity because a `signature` field was present, with
  // no verification. Sixteen hex digits and any base64 bought a distinct party:
  // three of them moved a finding from stale to aging, and one forged
  // refutation contested a two-signer finding for free.
  const fake = (i: number) => ({
    algorithm: 'ed25519' as const,
    keyId: `deadbeef${i}`.padEnd(16, '0').slice(0, 16),
    value: 'AAAA',
  });
  const forged = finding({
    observations: [
      { at: '2026-08-29T00:00:00Z', by: 'a', verdict: 'confirmed', environment: env('linux'), signature: fake(1) },
      { at: '2026-08-29T00:00:00Z', by: 'b', verdict: 'confirmed', environment: env('darwin'), signature: fake(2) },
      { at: '2026-08-29T00:00:00Z', by: 'c', verdict: 'confirmed', environment: env('win32'), signature: fake(3) },
    ] as never,
  });
  assert.deepEqual(disagreement(forged, NOW, KEYS), { confirmers: 0, refuters: 0 });

  const contested = finding({
    observations: [
      { at: '2026-08-28T00:00:00Z', by: 'a', verdict: 'confirmed', environment: env('linux') },
      { at: '2026-08-29T00:00:00Z', by: 'x', verdict: 'refuted', signature: fake(9) },
    ] as never,
  });
  assert.notEqual(standing(contested, NOW, KEYS), 'contested');
});

test('invented names cannot buy breadth', () => {
  // The previous cap was min(environments, distinct `by`) -- worthless, since
  // `by` is free text. Eight environments under one name capped to 1; the same
  // eight under eight invented names scored 4.0 and took scopeSupport to 0.956
  // against 0.505 for an honest single-environment report.
  const invented = finding({
    observations: Array.from({ length: 8 }, (_, i) => ({
      at: '2026-08-29T00:00:00Z',
      by: `invented-${i}`,
      verdict: 'confirmed',
      environment: env(`fake-${i}`),
    })) as never,
  });
  const honest = finding({
    observations: [
      { at: '2026-08-29T00:00:00Z', by: 'a', verdict: 'confirmed', environment: env('linux') },
    ] as never,
  });
  assert.equal(
    effectiveEnvironments(invented, KEYS, NOW),
    effectiveEnvironments(honest, KEYS, NOW),
    'unsigned breadth is capped regardless of how many names claim it',
  );
});
