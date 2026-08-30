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
  assert.equal(confidence(withNoise, NOW), confidence(clean, NOW));
  assert.equal(standing(withNoise, NOW), standing(clean, NOW));
  assert.deepEqual(disagreement(withNoise, NOW).refuters, 0);
});

test('a signed refutation does contest, and clears only at two distinct later signers', () => {
  const contested = signedFinding([
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
  ]);
  assert.equal(standing(contested, NOW), 'contested');
  assert.equal(confidence(contested, NOW), 0);

  const oneAnswer = signedFinding([
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
    { key: C, obs: { at: '2026-08-27T00:00:00Z', by: 'carol', verdict: 'confirmed', environment: env('darwin') } },
  ]);
  assert.equal(standing(oneAnswer, NOW), 'contested', 'one confirmation must not clear a refutation');

  const cleared = signedFinding([
    { key: A, obs: { at: '2026-08-25T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
    { key: C, obs: { at: '2026-08-27T00:00:00Z', by: 'carol', verdict: 'confirmed', environment: env('darwin') } },
    { key: D, obs: { at: '2026-08-28T00:00:00Z', by: 'dave', verdict: 'confirmed', environment: env('win32') } },
  ]);
  assert.notEqual(standing(cleared, NOW), 'contested');
  assert.ok(confidence(cleared, NOW) > 0);
});

test('a confirmation before the refutation does not help clear it', () => {
  const f = signedFinding([
    { key: A, obs: { at: '2026-08-20T00:00:00Z', by: 'alice', verdict: 'confirmed', environment: env('linux') } },
    { key: C, obs: { at: '2026-08-21T00:00:00Z', by: 'carol', verdict: 'confirmed', environment: env('darwin') } },
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' } },
  ]);
  assert.equal(disagreement(f, NOW).confirmers, 0);
  assert.equal(standing(f, NOW), 'contested');
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
  assert.notEqual(standing(futureRefutation, NOW), 'contested');
  assert.ok(confidence(futureRefutation, NOW) > 0);

  // Future confirmations must not clear a real refutation.
  const futureClear = signedFinding([
    ...base,
    { key: B, obs: { at: '2026-08-26T00:00:00Z', by: 'bob', verdict: 'refuted' as const } },
    { key: C, obs: { at: '2099-01-01T00:00:00Z', by: 'carol', verdict: 'confirmed' as const, environment: env('darwin') } },
    { key: D, obs: { at: '2099-01-01T00:00:00Z', by: 'dave', verdict: 'confirmed' as const, environment: env('win32') } },
  ]);
  assert.equal(standing(futureClear, NOW), 'contested');

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
  assert.equal(derivedVerdict(f, { since: new Date('2026-08-25T00:00:00Z') }), 'inconclusive');
  // A seal before the later observation resolves from it.
  assert.equal(
    derivedVerdict(f, { since: new Date('2026-08-10T00:00:00Z'), asOf: NOW }),
    'confirmed',
  );
  // asOf excludes evidence recorded after the resolution.
  assert.equal(
    derivedVerdict(f, { since: new Date('2026-08-10T00:00:00Z'), asOf: new Date('2026-08-15T00:00:00Z') }),
    'inconclusive',
  );
});

test('latestObservation does not throw on a finding with no observations', () => {
  assert.equal(latestObservation(finding()), undefined);
});
