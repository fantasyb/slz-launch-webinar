/**
 * The contradiction detector: fires on the two real shapes, and stays quiet
 * on the ordinary session, which is the property that matters more.
 *
 * The replay at the end runs it over the thirty committed trial transcripts
 * -- real Claude Code sessions against a server carrying both trap shapes by
 * construction. Control and empty arms never recovered from either trap, so
 * a fire there is a false positive; gateway arms on the stale-mapping
 * scenario recovered through a superset call every time, so silence there
 * is a miss. The silent-cap scenario was recovered by paging, which is a
 * continuation and not a superset, and the detector is expected to miss it;
 * the test pins that expectation rather than hiding it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { summarise, detect, addedBy, type CallSummary } from '../src/lib/cairn/contradiction';

const S = (args: Record<string, unknown>, text: string) => summarise(args, text, '2026-09-02T00:00:00Z');

test('empty success, then a strict superset that returns rows, is a contradiction', () => {
  const a = S({ object: 'Case', filter: { status: 'open' } }, '{"status":"success","records":[]}');
  const b = S({ object: 'Case', filter: { status: 'open' }, mapping_id: 'mp_cases_v2' }, '{"status":"success","records":[{"id":1},{"id":2}]}');
  const c = detect([a], b);
  assert.equal(c?.kind, 'empty-then-nonempty');
  assert.deepEqual(c?.added, ['mapping_id']);
});

test('N rows with nothing saying more, then a superset with more rows, is a contradiction', () => {
  const rows = (n: number) => JSON.stringify({ status: 'success', records: Array.from({ length: n }, (_, i) => ({ id: i })) });
  const a = S({ object: 'Contact' }, rows(50));
  const b = S({ object: 'Contact', include_all: true }, rows(137));
  assert.equal(detect([a], b)?.kind, 'more-with-superset');
});

test('the ordinary session is quiet', () => {
  const rows = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ status: 'success', records: Array.from({ length: n }, (_, i) => ({ id: i })), ...extra });
  /* a changed value on a shared key is a different question */
  assert.equal(detect([S({ object: 'Account', limit: 10 }, rows(10))], S({ object: 'Account', limit: 100 }, rows(100))), null);
  /* a narrowing filter returns fewer, never fires */
  assert.equal(detect([S({ object: 'Contact' }, rows(50))], S({ object: 'Contact', filter: { status: 'churned' } }, rows(12))), null);
  /* the next page is a continuation, not a superset */
  assert.equal(detect([S({ object: 'Contact' }, rows(50, { next_page_token: 'x' }))], S({ object: 'Contact', page_token: 'x' }, rows(50))), null);
  /* a result that declared more exists was not silent about it */
  assert.equal(detect([S({ object: 'Contact' }, rows(50, { total: 137 }))], S({ object: 'Contact', all: true }, rows(137))), null);
  assert.equal(detect([S({ q: 'x' }, JSON.stringify({ records: [1], done: false }))], S({ q: 'x', all: true }, JSON.stringify({ records: [1, 2, 3], done: true }))), null);
  /* prose is never empty or more */
  assert.equal(detect([S({ a: 1 }, 'nothing here')], S({ a: 1, b: 2 }, 'three things here')), null);
  /* the same call twice is not a superset */
  assert.equal(detect([S({ object: 'Case' }, rows(0))], S({ object: 'Case' }, rows(3))), null);
  /* an empty result followed by an unrelated tool's shape: different args entirely */
  assert.equal(detect([S({ object: 'Case' }, rows(0))], S({ id: '001' }, rows(1))), null);
  /* a bound cannot turn nothing into something: empty at limit 1000, rows at limit 50 with a mapping added, fires */
  assert.equal(detect([S({ object: 'Case', limit: 1000 }, rows(0))], S({ object: 'Case', limit: 50, mapping_id: 'v2' }, rows(29)))?.kind, 'empty-then-nonempty');
  /* but a changed bound explains "more" by itself, so with rows on both sides it stays quiet */
  assert.equal(detect([S({ object: 'Case', limit: 10 }, rows(10))], S({ object: 'Case', limit: 100, mapping_id: 'v2' }, rows(29))), null);
  assert.equal(addedBy({ a: 1 }, { a: 1, cursor: 'x' }), null);
  assert.deepEqual(addedBy({ a: 1 }, { a: 1, b: 2, cursor: 'x' }), ['b', 'cursor']);
});

/* ---- replay over the committed trial transcripts ------------------------ */

const RUN = path.join(process.cwd(), 'data', 'gateway-trials', 'run-2026-09-02T0529-haiku.json');

function firesIn(transcript: string): string[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const history = new Map<string, CallSummary[]>();
  const fired: string[] = [];
  for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev: { message?: { content?: Array<Record<string, unknown>> } };
    try { ev = JSON.parse(line); } catch { continue; }
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'tool_use') uses.set(String(block.id), { name: String(block.name), input: (block.input ?? {}) as Record<string, unknown> });
      if (block.type === 'tool_result') {
        const use = uses.get(String(block.tool_use_id));
        if (!use || !use.name.startsWith('mcp__records__')) continue;
        const own = Array.isArray(block.content) ? String((block.content as Array<{ text?: string }>)[0]?.text ?? '') : '';
        if (own.includes('"status":"error"')) continue;
        const summary = summarise(use.input, own.split('\n--- from your')[0]);
        const h = history.get(use.name) ?? [];
        const c = detect(h, summary);
        if (c) fired.push(`${use.name}: ${c.kind} (+${c.added.join(',')})`);
        h.push(summary);
        history.set(use.name, h);
      }
    }
  }
  return fired;
}

test('replayed over thirty real transcripts: quiet where nothing was recovered, loud where a superset recovered it', () => {
  const run = JSON.parse(fs.readFileSync(RUN, 'utf8')) as { trials: Array<{ scenario: string; arm: string; trial: number; transcript: string; usedExplicitMapping: boolean }> };
  const results = run.trials.map((t) => ({ ...t, fires: firesIn(path.join(process.cwd(), t.transcript)) }));
  const quiet = results.filter((t) => t.arm !== 'gateway');
  for (const t of quiet) assert.deepEqual(t.fires, [], `${t.scenario} ${t.arm} #${t.trial} fired with nothing recovered: ${t.fires}`);
  const stale = results.filter((t) => t.arm === 'gateway' && t.scenario === 'B-stale-mapping');
  for (const t of stale) {
    assert.ok(t.fires.some((f) => f.includes('empty-then-nonempty')), `${t.scenario} gateway #${t.trial} recovered through mapping_id and the detector was silent: ${t.fires}`);
  }
  /* The silent cap was recovered by paging, a continuation, and the detector is expected to miss it. Pinned so a change here is seen. */
  const cap = results.filter((t) => t.arm === 'gateway' && t.scenario === 'A-silent-cap');
  const capFires = cap.flatMap((t) => t.fires);
  assert.ok(capFires.every((f) => !f.includes('empty-then-nonempty')), `no empty-then-nonempty should appear on the cap scenario: ${capFires}`);
  console.log(`  replay: ${quiet.length} non-recovering trials silent; ${stale.length}/${stale.length} stale-mapping recoveries detected; cap-scenario fires: ${capFires.length} (${capFires.join('; ') || 'none'})`);
});
