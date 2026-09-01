/**
 * The brief is pushed at a reader who did not ask for it, so its failure mode
 * is not "missed one" -- it is "spent everyone's attention on nothing". These
 * pin the behaviours that keep that cost bounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, briefEntries } from '../src/lib/cairn/brief';
import { loadCorpus } from '../src/lib/cairn/load';

const corpus = loadCorpus();

const CLOCK =
  'This is a Next.js App Router project. Add a page at app/now/page.tsx that shows the ' +
  "current server time and today's date, and link to it from the home page.";
const UNRELATED =
  'Add German and French translations for the checkout flow copy.';

test('silence is a valid answer and the common one', () => {
  assert.equal(brief(UNRELATED, corpus, { useLocalEnvironment: true }), '');
  assert.equal(brief('', corpus).length, 0);
  assert.equal(brief(CLOCK, []).length, 0);
});

test('a task with a recorded trap gets it, named and with the fix', () => {
  const entries = briefEntries(CLOCK, corpus, { useLocalEnvironment: true });
  assert.ok(entries.length > 0, 'expected the App Router clock trap');
  assert.equal(entries[0].id, 'cairn-0005');
  const text = brief(CLOCK, corpus, { useLocalEnvironment: true });
  assert.match(text, /cairn-0005/);
  assert.match(text, /force-dynamic/);
});

test('never more than the caller asked for', () => {
  assert.ok(briefEntries(CLOCK, corpus, { limit: 1, useLocalEnvironment: true }).length <= 1);
  assert.ok(briefEntries(CLOCK, corpus, { useLocalEnvironment: true }).length <= 3);
});

/*
 * A budget that clips mid-block would hand over a truncated workaround, which
 * is worse than handing over nothing: the reader acts on half an instruction.
 * Entries are dropped whole instead.
 */
test('the character budget drops whole findings, never half of one', () => {
  const tight = brief(CLOCK, corpus, { maxChars: 400, useLocalEnvironment: true });
  assert.ok(tight === '' || tight.length <= 400, `budget overrun: ${tight.length}`);
  const full = brief(CLOCK, corpus, { useLocalEnvironment: true });
  assert.ok(full.length <= 2400, `default budget overrun: ${full.length}`);
});

test('it tells the reader the match is not a verdict', () => {
  const text = brief(CLOCK, corpus, { useLocalEnvironment: true });
  assert.match(text, /judge whether/i);
});

/*
 * The measured false-alarm rate that justifies the coverage floor. If a corpus
 * change pushes ordinary work back over the line, that is worth failing on:
 * the whole argument for injecting rather than offering rests on this number
 * staying small.
 */
test('ordinary work in uncovered domains stays quiet', () => {
  const ordinary = [
    'The mobile nav overlaps the header below 400px. Fix the CSS.',
    'Write a migration that adds a nullable `nickname` column to the users table.',
    'Resize uploaded avatars to 128x128 and strip EXIF before storing them.',
    'Add cursor-based pagination to the /api/comments endpoint.',
    'Convert the class components in src/legacy to function components.',
  ];
  const fired = ordinary.filter((t) => brief(t, corpus, { useLocalEnvironment: true }) !== '');
  assert.ok(fired.length <= 1, `too noisy: fired on ${fired.length} of ${ordinary.length} — ${fired.join(' | ')}`);
});
