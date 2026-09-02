/**
 * The tool surface: classify, and diff two looks at it.
 *
 * Both the trial and the gateway lean on these two functions, and each
 * decision below is one a real server has presented: a server that says
 * nothing, one that says destructive under a harmless name, one that says
 * read-only under a verb, a rename that must not read as loss plus gain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, diffSurface, shapeOf, findingNames } from '../src/lib/cairn/toolsurface';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, inputSchema: { type: 'object' as const, properties: { object: { type: 'string' } } }, ...extra });

test('the server\'s declaration comes first, the name only when it says nothing', () => {
  assert.equal(classify({ name: 'lookup', annotations: { readOnlyHint: true } }).permitted, true);
  assert.equal(classify({ name: 'purge_cache', annotations: { destructiveHint: true } }).permitted, false, 'a harmless name does not rescue a declared destructive tool');
  assert.equal(classify({ name: 'sync_now', annotations: { readOnlyHint: false } }).permitted, false);
  assert.equal(classify({ name: 'list_things' }).permitted, true);
  assert.equal(classify({ name: 'update_thing' }).permitted, false);
  const both = classify({ name: 'run_report', annotations: { readOnlyHint: true } });
  assert.equal(both.permitted, false, 'declared read-only under a write-looking name: both facts, a person decides');
  assert.match(both.reason, /declared read-only .*but the name reads as a write/);
});

test('an override permits an excluded tool and is carried with the reason it overruled', () => {
  const c = classify({ name: 'update_thing' }, { overrides: { update_thing: 'refreshes a cached read model only' } });
  assert.equal(c.permitted, true);
  assert.equal(c.overridden, 'refreshes a cached read model only');
  assert.match(c.reason, /overruled/);
  assert.equal(classify({ name: 'lookup', annotations: { readOnlyHint: true } }, { allowed: ['other'] }).permitted, false, 'allowedTools narrows');
});

test('a diff names what moved, and a rename is a rename rather than a loss and a gain', () => {
  const before = [tool('query_records', { description: 'Query' }), tool('get_record', { annotations: { readOnlyHint: true } })].map(shapeOf);
  const renamed = [tool('search_records', { description: 'Query' }), tool('get_record', { annotations: { readOnlyHint: true } })].map(shapeOf);
  const r = diffSurface(before, renamed);
  assert.deepEqual(r.map((c) => c.kind), ['renamed']);
  assert.equal(r[0].to, 'search_records');

  const grown = [...before, shapeOf(tool('delete_records', { annotations: { destructiveHint: true } }))];
  const a = diffSurface(before, grown);
  assert.deepEqual(a.map((c) => c.kind), ['appeared']);
  assert.match(a[0].detail, /declared destructive/);

  const flipped = [before[0], shapeOf(tool('get_record', { annotations: { readOnlyHint: false } }))];
  assert.deepEqual(diffSurface(before, flipped).map((c) => c.kind), ['annotations']);

  const narrowed = [shapeOf({ name: 'query_records', description: 'Query', inputSchema: { type: 'object' as const, properties: {} } }), before[1]];
  const s = diffSurface(before, narrowed);
  assert.deepEqual(s.map((c) => c.kind), ['schema']);
  assert.match(s[0].detail, /argument object removed/);

  assert.deepEqual(diffSurface(before, before), [], 'nothing moved, nothing said');
});

test('a finding names a tool by any of the names the same tool goes by', () => {
  assert.equal(findingNames(['query_records limit'], 'query_records', 'records'), true);
  assert.equal(findingNames(['mcp__records__query_records'], 'query_records', 'records'), true);
  assert.equal(findingNames(['get_record'], 'query_records', 'records'), false);
});
