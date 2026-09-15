/**
 * `misled` gets written. The ledger has carried the outcome since it was
 * designed and nothing ever produced one; the fail-then-recover arc is the one
 * outcome the machine already sees. A finding served on a program shortly
 * before an arc on that program did not prevent the trap it describes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { misledRows, MISLED_SOURCE, programsOf } from '../src/lib/cairn/misled';
import { reputations } from '../src/lib/cairn/memory';
import type { RetrievalRecord } from '../src/lib/cairn/ledger';
import type { ArcRecord } from '../src/lib/cairn/arcs';
import { finding } from './helpers';

const T = new Date('2026-09-10T12:00:00Z').getTime();
const at = (minutesBefore: number) => new Date(T - minutesBefore * 60_000).toISOString();
const NOW = new Date(T + 2 * 3_600_000); // two hours after the arc: old enough to reconcile

const sfFinding = finding({ id: 'cairn-8001', triggers: ['sf agent'], subject: { name: 'sf agent', ecosystem: 'shell', versions: '*' } });
const gitFinding = finding({ id: 'cairn-8002', triggers: ['git push'], subject: { name: 'git', ecosystem: 'shell', versions: '*' } });
const findings = [sfFinding, gitFinding];
const serve = (id: string, when: string): RetrievalRecord => ({ at: when, by: 'agent', query: 'q', returned: [{ id, rank: 1, strength: 'strong' }], source: 'mcp-proxy:result' });
const arc = (key: string, when: string, choice: ArcRecord['choice'] = 'offered', id = 'arc-0000aaaa'): ArcRecord => ({ at: when, arc: id, key, failing: `${key} --x`, choice });

test('programsOf compares the way an arc key does: first token of each trigger and of the subject', () => {
  assert.deepEqual([...programsOf(sfFinding)], ['sf']);
  assert.deepEqual([...programsOf(gitFinding)], ['git']);
});

test('a finding served shortly before an arc on its program is recorded misled, once', () => {
  const ledger = [serve('cairn-8001', at(50)), serve('cairn-8002', at(40))];
  const rows = misledRows({ ledger, arcs: [arc('sf agent', at(0))], findings, now: NOW });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.source, MISLED_SOURCE);
  assert.deepEqual(r.outcomes, { 'cairn-8001': 'misled' }, 'only the finding about the arc\'s program; the git one was not misleading');
  assert.equal(r.note, 'arc-0000aaaa', 'the arc id rides on the row, which is what makes this idempotent');
  assert.deepEqual(r.returned, [], 'an outcome row serves nothing');
  /* Idempotent: with the row in the ledger, the same arc produces nothing more. */
  assert.equal(misledRows({ ledger: [...ledger, r], arcs: [arc('sf agent', at(0))], findings, now: NOW }).length, 0);
  /* And memory.ts reads it as the reputation signal it always expected. */
  const rep = reputations([...ledger, r]).get('cairn-8001')!;
  assert.equal(rep.misled, 1);
});

test('what does NOT count: a slip, a fresh arc, a served finding outside the window, a different program, a finding served after the arc', () => {
  const ledger = [serve('cairn-8001', at(50))];
  const slip = [arc('sf agent', at(0)), arc('sf agent', at(-30), 'my-mistake')];
  assert.equal(misledRows({ ledger, arcs: slip, findings, now: NOW }).length, 0, 'answered "my mistake": the agent\'s slip, not the finding\'s fault');
  assert.equal(misledRows({ ledger, arcs: [arc('sf agent', at(0))], findings, now: new Date(T + 10 * 60_000) }).length, 0, 'ten minutes old: too young, a dismissal may still be coming');
  assert.equal(misledRows({ ledger: [serve('cairn-8001', at(5 * 60))], arcs: [arc('sf agent', at(0))], findings, now: NOW }).length, 0, 'served five hours before: outside the four-hour window');
  assert.equal(misledRows({ ledger, arcs: [arc('npm install', at(0))], findings, now: NOW }).length, 0, 'an arc on another program');
  assert.equal(misledRows({ ledger: [serve('cairn-8001', at(-10))], arcs: [arc('sf agent', at(0))], findings, now: NOW }).length, 0, 'served AFTER the arc: it could not have misled');
  /* An arc answered "bank" or "not surprising" still counts: the trap bit despite the finding. */
  const banked = [arc('sf agent', at(0)), arc('sf agent', at(-20), 'bank')];
  assert.equal(misledRows({ ledger, arcs: banked, findings, now: NOW }).length, 1);
});
