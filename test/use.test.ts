/**
 * Use-driven signals live in labels and urgency, never in the score.
 *
 * The clock in decay.ts is the prior that the SUBJECT drifted; it stays pure
 * over the finding so standing is signable, federable and auditable. What the
 * ledger adds is a render-time split of `stale` into `dormant` (nobody needed
 * it) and `stale` proper (served N times, nobody confirmed), and a weight that
 * sends re-check effort where use is. These pin that boundary from both sides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { confidence, standing, decayUrgency } from '../src/lib/cairn/decay';
import { useSignal, useLabel, useWeight, useWeightedUrgency } from '../src/lib/cairn/use';
import { verificationLine } from '../src/lib/cairn/attest';
import type { RetrievalRecord } from '../src/lib/cairn/ledger';
import { finding, signedFinding, makeKey, keyMap, env } from './helpers';

const A = makeKey('alice');
const KEYS = keyMap(A);
const NOW = new Date('2026-09-10T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const served = (id: string, at: string): RetrievalRecord => ({ at, by: 'agent', query: 'q', returned: [{ id, rank: 1, strength: 'strong' }], source: 'mcp-proxy:find' });

/* Confirmed 200 days ago on a 60-day half-life: freshness 0.099, well under stale. */
const decayed = finding({ id: 'cairn-7001', halfLifeDays: 60, observations: [{ at: daysAgo(200), by: 'someone', verdict: 'confirmed' }] });
/* Confirmed yesterday, SIGNED, in its own environment: the only way to be fresh (unsigned tops out at 0.45). */
const fresh = signedFinding(
  [{ key: A, obs: { at: daysAgo(1), by: 'alice', verdict: 'confirmed', environment: env('linux') } }],
  { id: 'cairn-7002', halfLifeDays: 180, scope: 'environment-specific' },
);

test('the score is a pure function of the file: decay.ts never reads the ledger', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'cairn', 'decay.ts'), 'utf8');
  assert.doesNotMatch(src, /from '\.\/ledger'/, 'decay.ts imports nothing from the ledger');
  assert.doesNotMatch(src, /from '\.\/use'/, 'and nothing from use.ts');
  /* And the same finding scores the same however much it was served. */
  assert.equal(standing(decayed, NOW, KEYS), 'stale');
  const c = confidence(decayed, NOW, KEYS);
  assert.ok(c < 0.3 && c > 0, `stale confidence ${c}`);
});

test('stale splits by use: dormant when nobody retrieved it since it was last confirmed, stale with the count when they did', () => {
  const none = useSignal(decayed, [], NOW);
  assert.deepEqual(none, { sinceConfirmed: 0, recent: 0, lastServedAt: null });
  assert.equal(useLabel(decayed, none, NOW, KEYS), 'dormant');
  assert.match(verificationLine(decayed, NOW, none), /^dormant \(not retrieved since last confirmed — untested because unneeded\) — attested by someone 200 days ago/);

  /* Retrievals BEFORE the confirmation do not count: the confirmation answered them. */
  const before = useSignal(decayed, [served('cairn-7001', daysAgo(300)), served('cairn-7001', daysAgo(250))], NOW);
  assert.equal(before.sinceConfirmed, 0);
  assert.equal(useLabel(decayed, before, NOW, KEYS), 'dormant');

  /* Retrievals after it: real doubt, with the number. Other findings' rows are not mine. */
  const after = useSignal(decayed, [served('cairn-7001', daysAgo(100)), served('cairn-7001', daysAgo(30)), served('cairn-7001', daysAgo(2)), served('cairn-7002', daysAgo(2))], NOW);
  assert.equal(after.sinceConfirmed, 3);
  assert.equal(after.recent, 2, 'two inside the 90-day window');
  assert.equal(after.lastServedAt, daysAgo(2));
  assert.equal(useLabel(decayed, after, NOW, KEYS), 'stale');
  assert.match(verificationLine(decayed, NOW, after), /^stale \(served 3 times since, never re-confirmed\) — /);
});

test('every other standing passes through untouched, whatever the ledger says', () => {
  assert.equal(standing(fresh, NOW, KEYS), 'fresh');
  assert.equal(useLabel(fresh, useSignal(fresh, [], NOW), NOW, KEYS), 'fresh', 'fresh and unused is fresh, not dormant');
  assert.equal(useLabel(fresh, useSignal(fresh, [served('cairn-7002', daysAgo(0.5))], NOW), NOW, KEYS), 'fresh');
  /* verificationLine resolves keys from the corpus home, where alice's key is not published, so it reads the
   * observation as unsigned (aging) — the point here is only that nothing about the line says dormant or stale. */
  assert.match(verificationLine(fresh, NOW, useSignal(fresh, [], NOW)), /^aging — attested by alice 1 day ago/);
  const retired = finding({ ...decayed, status: 'retired' });
  assert.equal(useLabel(retired, useSignal(retired, [], NOW), NOW, KEYS), 'retired');
});

test('the use weight floors at 0.5, rises with recent retrievals, and saturates below 2', () => {
  assert.equal(useWeight(0), 0.5);
  assert.equal(useWeight(1), 1.25);
  let prev = useWeight(0);
  for (let n = 1; n <= 20; n++) {
    const w = useWeight(n);
    assert.ok(w > prev && w < 2, `monotone and bounded at n=${n}: ${w}`);
    prev = w;
  }
});

test('re-check effort goes where use is: a used finding outranks an identical unused one, and the unused one is not zero', () => {
  const a = finding({ id: 'cairn-7003', halfLifeDays: 60, observations: [{ at: daysAgo(80), by: 'someone', verdict: 'confirmed' }] });
  const b = finding({ ...a, id: 'cairn-7004' });
  const ledger = [served('cairn-7003', daysAgo(3)), served('cairn-7003', daysAgo(1))];
  const ua = useWeightedUrgency(a, ledger, NOW);
  const ub = useWeightedUrgency(b, ledger, NOW);
  assert.equal(decayUrgency(a, NOW), decayUrgency(b, NOW), 'the pure urgency is identical');
  assert.ok(ua > ub, `used ${ua} > unused ${ub}`);
  assert.ok(ub > 0, 'a dormant finding still gets a turn');
  assert.equal(ub, decayUrgency(b, NOW) * 0.5);
});
