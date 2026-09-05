/**
 * The impact analyzer turns real ledger events into the one decision number:
 * how often an un-derivable (expensive) finding fired UNASKED on a live result.
 * These pin that push first-deliveries are counted (reminders are not new
 * value), that un-derivable vs cheap is split by rediscovery cost, that the
 * minutes estimate follows the stated assumptions, and that a window excludes
 * older rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeImpact, humanMinutes, COST_MINUTES, type FindingLite } from '../src/lib/cairn/impact';
import type { RetrievalRecord } from '../src/lib/cairn/ledger';

const findings = new Map<string, FindingLite>([
  ['cairn-0001', { id: 'cairn-0001', title: 'silent 50-row cap', cost: 'hours', tool: 'sf-all' }],
  ['cairn-0002', { id: 'cairn-0002', title: 'just paginate', cost: 'minutes', tool: 'list_commits' }],
  ['cairn-0003', { id: 'cairn-0003', title: 'wrong-org empty result', cost: 'days', tool: 'sf-all' }],
]);

function push(id: string, tool: string, session: string, at: string, reminder = false): RetrievalRecord {
  return {
    at, by: 'claude-opus', query: `${tool} [result${reminder ? '-reminder' : ''}]`,
    returned: [{ id, rank: 1, strength: 'strong' }],
    source: reminder ? 'mcp-proxy:result-reminder' : 'mcp-proxy:result',
    session,
  };
}

test('push first-deliveries count as value; reminders do not', () => {
  const rows = [
    push('cairn-0001', 'sf-all', 's1', '2026-09-01T10:00:00Z'),
    push('cairn-0001', 'sf-all', 's1', '2026-09-01T10:05:00Z', true), // reminder, same session
    push('cairn-0002', 'list_commits', 's1', '2026-09-01T11:00:00Z'),
  ];
  const s = summarizeImpact(rows, findings);
  assert.equal(s.pushFirstDeliveries, 2, 'two first deliveries');
  assert.equal(s.pushReminders, 1, 'one reminder, tracked separately');
  assert.equal(s.distinctFindings, 2);
});

test('the decision number splits un-derivable from cheap by rediscovery cost', () => {
  const rows = [
    push('cairn-0001', 'sf-all', 's1', '2026-09-01T10:00:00Z'), // hours -> un-derivable
    push('cairn-0003', 'sf-all', 's2', '2026-09-02T10:00:00Z'), // days  -> un-derivable
    push('cairn-0002', 'list_commits', 's3', '2026-09-02T12:00:00Z'), // minutes -> cheap
  ];
  const s = summarizeImpact(rows, findings);
  assert.equal(s.unDerivableFires, 2, 'hours + days fires are the decision number');
  assert.equal(s.cheapFires, 1, 'the minutes fire is cheap');
  /* Upper bound uses the published assumptions. */
  assert.equal(s.estMinutesUpperBound, COST_MINUTES.hours + COST_MINUTES.days + COST_MINUTES.minutes);
  assert.equal(s.estMinutesUnDerivableOnly, COST_MINUTES.hours + COST_MINUTES.days);
});

test('most-valuable finding sorts first, and carries the real live tool', () => {
  const rows = [
    push('cairn-0002', 'list_commits', 's1', '2026-09-01T10:00:00Z'),
    push('cairn-0003', 'sf-all', 's2', '2026-09-01T11:00:00Z'), // days: highest value
  ];
  const s = summarizeImpact(rows, findings);
  assert.equal(s.fired[0].id, 'cairn-0003', 'the days-cost finding leads');
  assert.equal(s.fired[0].tool, 'sf-all', 'tool taken from the live ledger row');
});

test('a window excludes older rows and undated rows', () => {
  const rows = [
    push('cairn-0001', 'sf-all', 's1', '2026-08-01T10:00:00Z'), // old
    push('cairn-0003', 'sf-all', 's2', '2026-09-04T10:00:00Z'), // in window
    push('cairn-0002', 'x', 's3', 'not-a-date'),                // undated
  ];
  const sinceMs = Date.parse('2026-09-01T00:00:00Z');
  const s = summarizeImpact(rows, findings, { sinceMs });
  assert.equal(s.pushFirstDeliveries, 1, 'only the in-window dated row counts');
  assert.equal(s.fired[0].id, 'cairn-0003');
});

test('an unknown finding id still counts as a fire, defaulting to cheap', () => {
  const rows = [push('cairn-9999', 'mystery', 's1', '2026-09-01T10:00:00Z')];
  const s = summarizeImpact(rows, findings);
  assert.equal(s.pushFirstDeliveries, 1);
  assert.equal(s.cheapFires, 1, 'unknown cost defaults to minutes so it never inflates the decision number');
  assert.equal(s.fired[0].title, '(unknown finding)');
});

test('humanMinutes reads like time', () => {
  assert.equal(humanMinutes(45), '45m');
  assert.equal(humanMinutes(90), '1h 30m');
  assert.equal(humanMinutes(120), '2h');
  assert.equal(humanMinutes(0), '0m');
});
