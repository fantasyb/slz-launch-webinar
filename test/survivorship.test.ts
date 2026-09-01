/**
 * Survivorship rules.
 *
 * These exist because the first version of admit had exactly one rule --
 * "keep the observation, discard the record" -- and that silently loses the
 * clearer title, the better workaround, and any output the original never
 * captured. At fifty contributors that is most of the value of a duplicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus } from '../src/lib/cairn/load';
import { proposeSurvivor } from '../src/lib/cairn/survivorship';
import type { Finding } from '../src/lib/cairn/schema';

const base = loadCorpus().find((f) => f.id === 'cairn-0001')!;
const other = loadCorpus().find((f) => f.id === 'cairn-0002')!;
const find = (ds: ReturnType<typeof proposeSurvivor>, field: string) => ds.find((d) => d.field === field);

/*
 * Attestation is the one thing that must never be lost. A duplicate is
 * evidence the finding is real, and `confidence` and `scope: universal` both
 * key on how many people saw it in how many environments -- so discarding an
 * observation actively weakens a claim that just got stronger.
 */
test('observations union rather than choose', () => {
  const incoming = { ...base, observations: other.observations } as Finding;
  const d = find(proposeSurvivor(base, incoming), 'observations');
  assert.equal(d?.rule, 'union');
  assert.equal(d?.value, (base.observations?.length ?? 0) + (other.observations?.length ?? 0));
});

/*
 * Where two records disagree about staleness, the disagreement resolves toward
 * checking again rather than toward asserting.
 */
test('a half-life disagreement takes the shorter one', () => {
  const incoming = { ...base, halfLifeDays: base.halfLifeDays + 60 } as Finding;
  assert.equal(find(proposeSurvivor(base, incoming), 'halfLifeDays')?.value, base.halfLifeDays);
  const shorter = { ...base, halfLifeDays: 7 } as Finding;
  assert.equal(find(proposeSurvivor(base, shorter), 'halfLifeDays')?.value, 7);
});

/*
 * Prose is surfaced, never resolved. "Most complete" decided mechanically
 * becomes "most verbose", and the real case that motivated this had the
 * SHORTER incoming title as the better one for a searcher -- it led with the
 * symptom rather than the diagnosis.
 */
test('competing prose is handed to a person with both values', () => {
  const incoming = { ...base, title: 'curl exit 56 means blocked, not down' } as Finding;
  const d = find(proposeSurvivor(base, incoming), 'title');
  assert.equal(d?.rule, 'judged');
  assert.equal(d?.existing, base.title);
  assert.equal(d?.incoming, 'curl exit 56 means blocked, not down');
  assert.equal(d?.value, undefined, 'a judged field must not propose a winner');
});

/* Nothing versus something is not a judgement call. */
test('a field the existing record lacks is taken outright', () => {
  const stripped = { ...base, workaround: undefined } as Finding;
  const incoming = { ...base, workaround: 'check the proxy status endpoint first' } as Finding;
  const d = find(proposeSurvivor(stripped, incoming), 'workaround');
  assert.equal(d?.rule, 'union');
  assert.equal(d?.value, 'check the proxy status endpoint first');
});

test('identical records propose nothing beyond the observation union', () => {
  const ds = proposeSurvivor(base, { ...base, observations: [] } as Finding);
  assert.ok(!ds.some((d) => d.rule === 'judged'), `identical prose produced: ${ds.map((d) => d.field)}`);
});
