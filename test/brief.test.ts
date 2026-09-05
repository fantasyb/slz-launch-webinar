/**
 * The brief is pushed at a reader who did not ask for it, so its failure mode
 * is not "missed one" -- it is "spent everyone's attention on nothing". These
 * pin the behaviours that keep that cost bounded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brief, briefEntries, renderBrief, tierOf, type BriefEntry } from '../src/lib/cairn/brief';
import { loadCorpus } from '../src/lib/cairn/load';

const corpus = loadCorpus();

const entry = (tier: BriefEntry['tier']): BriefEntry => ({
  id: 'cairn-9001',
  title: 'a tool silently returns a wrong count',
  reality: 'the tool answers a count question with a plausible but wrong number and no error, so it is trusted.',
  workaround: 'do not trust a single call; cross-check the total another way before reporting it.',
  tier,
});

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
/*
 * The value gate the records-opus trial motivated: an expensive-to-rediscover
 * trap is worth the full block on every task; a cheap one is demoted to a hint
 * the model can expand, because pushing the full block at a trap the model
 * recovers from on its own costs more than it saves.
 */
test('an expensive trap (full tier) is rendered as the complete block', () => {
  const text = renderBrief([entry('full')]);
  assert.match(text, /WHAT HAPPENS:/, 'full block present');
  assert.match(text, /INSTEAD:/, 'workaround present');
  assert.match(text, /cairn-9001/);
});

test('a cheap trap (hint tier) is demoted to an expandable hint, not withheld', () => {
  const text = renderBrief([entry('hint')]);
  assert.notEqual(text, '', 'the trap is still delivered — not withheld');
  assert.doesNotMatch(text, /WHAT HAPPENS:/, 'no full block for a cheap trap');
  assert.match(text, /cairn_find\("cairn-9001"\)/, 'names the call that expands it');
  assert.match(text, /cairn-9001/);
  /* The whole point: the hint costs far less than the full block would. */
  assert.ok(text.length < renderBrief([entry('full')]).length, 'hint is cheaper than the full block');
});

test('the model, not the gate, is the last word: a hinted trap still names itself', () => {
  /* Even demoted, the finding is present and self-describing, so an agent that
   * judges the task needs it can expand it — the gate never silently blocks. */
  const text = renderBrief([entry('hint')]);
  assert.match(text, /wrong count/, 'the trap is named, not hidden');
});

test('tierOf: only minutes is cheap enough to demote', () => {
  assert.equal(tierOf('minutes'), 'hint');
  assert.equal(tierOf('hours'), 'full');
  assert.equal(tierOf('days'), 'full');
});

/* Every real finding still tiers to exactly one of the two channels. */
test('every finding in the live corpus resolves to a valid tier', () => {
  for (const f of corpus) assert.ok(tierOf(f.cost) === 'full' || tierOf(f.cost) === 'hint', f.id);
});

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
