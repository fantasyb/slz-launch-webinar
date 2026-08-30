/**
 * The gate must fail closed. Each case here is a way it did not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type Adjudication } from '../src/lib/cairn/adjudicate';

const clean = (reviewer: string): Adjudication => ({
  reviewer,
  verdict: { verdict: 'clean', reasons: [] },
});
const flag = (reviewer: string): Adjudication => ({
  reviewer,
  verdict: { verdict: 'hostile', reasons: ['nope'] },
});
const errored = (reviewer: string): Adjudication => ({ reviewer, error: 'timeout' });

test('one surviving reviewer cannot clear a panel of four', () => {
  const results = [clean('a'), errored('b'), errored('c'), errored('d')];
  const outcome = decide(results, 4);
  assert.equal(outcome.pass, false, 'three silenced reviewers is not unanimous approval');
  assert.match(outcome.reason, /quorum/);
});

test('a quorum of clean answers passes', () => {
  assert.equal(decide([clean('a'), clean('b'), clean('c'), errored('d')], 4).pass, true);
});

test('a single flag holds regardless of quorum', () => {
  assert.equal(decide([flag('a'), clean('b'), clean('c'), clean('d')], 4).pass, false);
  // ...including when the quorum itself was not met, so the reason reported is
  // the flag rather than the shortfall.
  const outcome = decide([flag('a'), errored('b'), errored('c'), errored('d')], 4);
  assert.equal(outcome.pass, false);
  assert.equal(outcome.flagged.length, 1);
});

test('all reviewers erroring holds', () => {
  assert.equal(decide([errored('a'), errored('b')], 2).pass, false);
});

test('a single configured reviewer answering clean passes', () => {
  assert.equal(decide([clean('a')], 1).pass, true);
});

test('the denominator is what was consulted, not what replied', () => {
  // Same results, different expectation: one clean answer out of four
  // configured reviewers must not read the same as one out of one.
  const results = [clean('a')];
  assert.equal(decide(results, 1).pass, true);
  assert.equal(decide(results, 4).pass, false);
});
