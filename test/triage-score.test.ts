/**
 * The cheap triage gate: score first, escalate only the winners, cache the
 * scores. Pins that a no-tell trap clears the bar, a frontier-recoverable or
 * thin candidate does not, and that a re-gate reads the cache instead of
 * recomputing — the property that makes re-tuning the threshold free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scoreCandidate, gateCandidates, DEFAULT_TRIAGE_THRESHOLD } from '../src/lib/cairn/triageScore';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-score-'));

const noTellTrap = {
  tool: 'query_records',
  title: 'query_records silently caps results at 50',
  expectation: 'a limit of 1000 returns up to 1000 rows',
  reality: 'at most 50 rows come back with no total and no cursor, so a count looks complete but silently undercounts',
  workaround: 'partition the query by region and sum; do not treat a 50-length result as the whole set',
};
const derivableNoise = {
  tool: 'list_commits',
  title: 'list_commits returns one page',
  expectation: 'all commits are returned',
  reality: 'only the first page of commits is returned',
  workaround: 'just paginate / increase the per_page limit, it is obvious',
};
const thin = { tool: 'x', expectation: '', reality: '', workaround: '' };

test('a no-tell trap scores high; a generic-reflex or thin one scores low', () => {
  const a = scoreCandidate(noTellTrap);
  const b = scoreCandidate(derivableNoise);
  const c = scoreCandidate(thin);
  assert.ok(a.score >= DEFAULT_TRIAGE_THRESHOLD, `no-tell trap should clear the bar, got ${a.score}`);
  assert.ok(b.score < DEFAULT_TRIAGE_THRESHOLD, `frontier-recoverable should not, got ${b.score}`);
  assert.ok(c.score < DEFAULT_TRIAGE_THRESHOLD, `thin should not, got ${c.score}`);
  assert.ok(a.reasons.some((r) => /no-tell/.test(r)), 'says why it is worth it');
  assert.ok(b.reasons.some((r) => /reflex/.test(r)), 'says why it is not');
});

test('the gate escalates the winners and defers the rest', () => {
  const dir = tmp();
  const cands = [noTellTrap, derivableNoise, thin].map((data, i) => ({ file: `c${i}`, data }));
  const { escalate, deferred } = gateCandidates(dir, cands);
  assert.equal(escalate.length, 1, 'only the no-tell trap escalates');
  assert.equal((escalate[0].data as { tool: string }).tool, 'query_records');
  assert.equal(deferred.length, 2, 'the reflex and the thin one wait');
});

test('scores are cached: a re-gate reads the cache, never recomputes', () => {
  const dir = tmp();
  const cands = [{ file: 'c0', data: noTellTrap }];
  gateCandidates(dir, cands);
  const cacheFile = path.join(dir, '.triage-scores.json');
  assert.ok(fs.existsSync(cacheFile), 'the cache was written');
  /* Poison the cached score. A re-gate that recomputed would ignore it and
   * escalate again; one that reads the cache will now defer. */
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
  const key = Object.keys(cache)[0];
  cache[key] = { score: 0.1, reasons: ['poisoned'], at: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const { escalate, deferred } = gateCandidates(dir, cands);
  assert.equal(escalate.length, 0, 'used the cached (poisoned) score, did not recompute');
  assert.equal(deferred[0].score.reasons[0], 'poisoned', 'and returned the cached reasons');
});

test('the threshold is tunable — the same corpus re-gates from the cache', () => {
  const dir = tmp();
  const cands = [{ file: 'c0', data: derivableNoise }];
  assert.equal(gateCandidates(dir, cands, 0.9).escalate.length, 0, 'a high bar escalates nothing');
  assert.equal(gateCandidates(dir, cands, 0.0).escalate.length, 1, 'a floor escalates everything');
});
