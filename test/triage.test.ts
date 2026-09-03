/**
 * Triage is the admission spine: it routes a gate verdict to an outcome, moves
 * settled candidates out of the queue, and keeps a yield ledger. The properties
 * that matter: a verdict maps to the honest outcome (a self-confirming check is
 * rejected, a trap that is not live here is deferred, not dropped), the queue
 * ALWAYS makes forward progress (a candidate cannot defer forever — it becomes a
 * lead), and the ledger measures admit-rate so volume is never grown blind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { routeVerdict, pendingCandidates, hasCheck, settle, yieldSummary, MAX_DEFERS, type Candidate } from '../src/lib/cairn/triage';

function drafts(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-triage-'));
  return dir;
}
function candidate(dir: string, name: string, data: Record<string, unknown>): Candidate {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return { file, data };
}

test('the gate verdict routes to the honest outcome', () => {
  assert.equal(routeVerdict('discriminates'), 'admitted', 'a discriminating check is a real finding');
  assert.equal(routeVerdict('same-either-way'), 'rejected', 'a self-confirming check is rejected, no judgment call');
  assert.equal(routeVerdict('no-delta'), 'rejected', 'an un-gateable check is not admitted unverified');
  assert.equal(routeVerdict('not-live'), 'deferred', 'a trap not live here waits for a machine where it is');
  assert.equal(routeVerdict('error'), 'deferred', 'an undecidable check retries');
});

test('hasCheck distinguishes a candidate ready for the gate from a raw harvest', () => {
  const dir = drafts();
  assert.equal(hasCheck(candidate(dir, 'raw.json', { tool: 'x' })), false, 'a raw sleep candidate has no check');
  assert.equal(hasCheck(candidate(dir, 'ready.json', { tool: 'x', check: { command: 'test 1 = 1' } })), true);
});

test('admitting and rejecting move the candidate out of the pending queue', () => {
  const dir = drafts();
  const a = candidate(dir, 'a.json', { tool: 'query' });
  const r = candidate(dir, 'r.json', { tool: 'list' });
  settle(dir, a, 'admitted', 'discriminates');
  settle(dir, r, 'rejected', 'same either way');
  assert.equal(pendingCandidates(dir).length, 0, 'neither is pending any more');
  assert.ok(fs.existsSync(path.join(dir, 'admitted', 'a.json')), 'admitted moved to admitted/');
  assert.ok(fs.existsSync(path.join(dir, 'rejected', 'r.json')), 'rejected moved to rejected/');
});

test('a deferred candidate stays pending but cannot defer forever', () => {
  const dir = drafts();
  candidate(dir, 'c.json', { tool: 'query_records' });

  /* Each pass re-reads the queue and defers the same candidate. */
  for (let i = 0; i < MAX_DEFERS - 1; i++) {
    const [c] = pendingCandidates(dir);
    assert.ok(c, `still pending on defer ${i + 1}`);
    settle(dir, c, 'deferred', 'trap not live on this machine');
    assert.equal(pendingCandidates(dir).length, 1, 'a deferral keeps it in the queue');
  }

  /* The MAX_DEFERS-th deferral escalates it to a lead instead of waiting again. */
  const [last] = pendingCandidates(dir);
  settle(dir, last, 'deferred', 'trap not live on this machine');
  assert.equal(pendingCandidates(dir).length, 0, 'it is no longer pending — the queue made progress');
  assert.ok(fs.existsSync(path.join(dir, 'leads', 'c.json')), 'it was kept as an unverified lead, not dropped');
});

test('the yield ledger measures admit-rate across terminal outcomes', () => {
  const dir = drafts();
  settle(dir, candidate(dir, 'a1.json', { tool: 't' }), 'admitted', '');
  settle(dir, candidate(dir, 'a2.json', { tool: 't' }), 'admitted', '');
  settle(dir, candidate(dir, 'r1.json', { tool: 't' }), 'rejected', '');
  settle(dir, candidate(dir, 'l1.json', { tool: 't' }), 'lead', '');

  const y = yieldSummary(dir);
  assert.equal(y.admitted, 2);
  assert.equal(y.rejected, 1);
  assert.equal(y.lead, 1);
  assert.equal(y.settled, 4, 'admitted + rejected + lead all left the queue');
  assert.equal(y.admitRate, 0.5, 'and the honest admit-rate is measured, not assumed');
});

test('pendingCandidates ignores settled subtrees and malformed files', () => {
  const dir = drafts();
  candidate(dir, 'good.json', { tool: 't', check: { command: 'true' } });
  fs.mkdirSync(path.join(dir, 'admitted'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'admitted', 'old.json'), '{"tool":"gone"}');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  const pending = pendingCandidates(dir);
  assert.equal(pending.length, 1, 'only the one good pending candidate');
  assert.equal(path.basename(pending[0].file), 'good.json');
});
