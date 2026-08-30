/**
 * The documentation must not state numbers the corpus contradicts.
 *
 * This has happened twice: the homepage rendered "4 excluded, 5 of them",
 * which cannot describe any set, and the README advertised a Brier score for
 * a forecast that is not scored. Both were written by hand beside code that
 * computed the real value. Prose drifts; a test does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadCorpus } from '../src/lib/cairn/load';
import { ledgerIntegrity } from '../src/lib/cairn/calibration';

const README = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

test('the README ledger count matches the corpus', () => {
  const m = README.match(/current count is (\d+) forecasts? recorded and (\d+) scored/i);
  assert.ok(m, 'the README must state the ledger count in a checkable form');
  const l = ledgerIntegrity(loadCorpus());
  assert.equal(Number(m[1]), l.total, 'recorded count in README disagrees with the corpus');
  assert.equal(Number(m[2]), l.scored, 'scored count in README disagrees with the corpus');
});

test('the README quotes no Brier score while none is earned', () => {
  const l = ledgerIntegrity(loadCorpus());
  if (l.scored > 0) return; // once something is scored, quoting a number is fair
  const quoted = README.match(/Brier\s+\d+\.\d+/i);
  assert.equal(
    quoted,
    null,
    `README quotes "${quoted?.[0]}" but zero forecasts are scored`,
  );
});

test('no page hardcodes a ledger count in prose', () => {
  // The counts must be interpolated from ledgerIntegrity, not written out.
  // "all four of my own" outlived the ledger having four of anything.
  const pages = ['src/app/page.tsx', 'src/app/skill.md/route.ts'];
  for (const file of pages) {
    // Comments are stripped first: this check is about what renders, and it
    // flagged the very comment explaining why the check exists.
    const text = fs
      .readFileSync(path.join(process.cwd(), file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const spelled = text.match(
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of\s+(?:my|the)\s+own|forecasts?|predictions?)\b/i,
    );
    assert.equal(spelled, null, `${file} spells out a count: "${spelled?.[0]}"`);
  }
});
