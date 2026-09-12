/**
 * Memory feeds ranking, and ranking is what the suites measure, so the ways
 * this can go wrong are quiet ones. These pin the three that would matter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reputations, memoryWeight, MIN_OUTCOMES, MEMORY_SPAN } from '../src/lib/cairn/memory';
import type { RetrievalRecord } from '../src/lib/cairn/ledger';

const rec = (outcomes: RetrievalRecord['outcomes']): RetrievalRecord => ({
  at: '2026-09-01T00:00:00Z', by: 'test', query: 'q', returned: [], outcomes,
});

test('no opinion until there is enough evidence for one', () => {
  const reps = reputations(Array.from({ length: MIN_OUTCOMES - 1 }, () => rec({ 'cairn-0001': 'helped' })));
  assert.equal(reps.get('cairn-0001')?.standing, null);
  assert.equal(memoryWeight(reps.get('cairn-0001')), 1, 'silence must be exactly neutral');
});

test('a finding nobody has graded is untouched', () => {
  const reps = reputations([rec({ 'cairn-0002': 'served' })]);
  assert.equal(reps.get('cairn-0002')?.standing, null);
  assert.equal(memoryWeight(reps.get('cairn-0099')), 1);
});

/*
 * `missed` means the right answer was present and did not lead: the ranking
 * failed the finding, not the other way round. Counting it against would push
 * a hard-to-retrieve record further down, making it harder to retrieve — the
 * feedback loop this whole design is arranged to avoid.
 */
test('being missed counts for a finding, never against it', () => {
  const missed = reputations(Array.from({ length: 4 }, () => rec({ 'cairn-0001': 'missed' })));
  assert.ok((missed.get('cairn-0001')?.standing ?? 0) > 0);
  assert.ok(memoryWeight(missed.get('cairn-0001')) > 1);
});

test('misleading readers costs a finding, and the cost is bounded', () => {
  const bad = reputations(Array.from({ length: 6 }, () => rec({ 'cairn-0001': 'misled' })));
  assert.equal(bad.get('cairn-0001')?.standing, -1);
  assert.equal(memoryWeight(bad.get('cairn-0001')), 1 - MEMORY_SPAN);
  const good = reputations(Array.from({ length: 6 }, () => rec({ 'cairn-0001': 'helped' })));
  assert.equal(memoryWeight(good.get('cairn-0001')), 1 + MEMORY_SPAN);
  assert.ok(MEMORY_SPAN <= 0.25, 'memory must stay one voice among several');
});
