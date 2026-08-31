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
import {
  ledgerIntegrity,
  allPredictions,
  EXCLUSION_REASONS,
} from '../src/lib/cairn/calibration';

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

/**
 * The third instance of the same class was not an arithmetic error: the total
 * was right and the reasons under it accounted for five of nine, because the
 * page named two of the seven ways a forecast fails to score. Both tests
 * below are structural — they hold whatever the corpus contains, and they
 * fail if a new exclusion rule is added to isScorableIn without a matching
 * reason in exclusionReason.
 */
test('the exclusion reasons partition the excluded set', () => {
  const l = ledgerIntegrity(loadCorpus());
  const summed = l.exclusions.reduce((a, e) => a + e.count, 0);
  assert.equal(
    summed,
    l.total - l.scored,
    `exclusion reasons account for ${summed} of ${l.total - l.scored} excluded forecasts`,
  );
});

test('every excluded prediction carries exactly one reason', () => {
  for (const p of allPredictions(loadCorpus())) {
    if (p.scorable) {
      assert.equal(p.excludedBecause, null, `${p.findingId}/${p.by} scores but names a reason`);
    } else {
      assert.ok(
        p.excludedBecause && EXCLUSION_REASONS.includes(p.excludedBecause),
        `${p.findingId}/${p.by} is excluded with no reason`,
      );
    }
  }
});

test('the homepage does not enumerate exclusion reasons in prose', () => {
  // The reasons must come from integrity.exclusions. Naming a status in the
  // rendered text is how a list of two came to stand for a partition of seven.
  const text = fs
    .readFileSync(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const named = text.match(/integrity\.(unanchored|legacyEncoding|broken|sealed|self)\b/);
  assert.equal(
    named,
    null,
    `the homepage renders integrity.${named?.[1]} directly instead of the partition`,
  );
});
