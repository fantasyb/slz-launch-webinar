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

/* Every real finding still tiers to exactly one of the two cost channels; `topical` is a match quality, never a cost tier. */
test('every finding in the live corpus resolves to a valid tier', () => {
  for (const f of corpus) assert.ok(tierOf(f.cost) === 'full' || tierOf(f.cost) === 'hint', f.id);
});

/*
 * WEAK BUT TOPICAL. Intent phrasing of a known trap earns exactly two caveats
 * (coverage, no error token) and so reads `weak`; the strong-only filter
 * blanked the brief on the same query `find` answered first. A genuinely
 * unknown task carries a third caveat — one distinctive term, or none — and
 * that is the line: a topical line for the first class, silence for the second.
 */
const SOFT_MCP = 'wiring MCP tool with zod schema validation for the inputs';
const TRAP_SHAPED = 'MCP tool argument is undefined in the handler even though the client sent it';
const PROXY_PARAPHRASE = 'connection refused when calling an external service from the agent';

test('a soft, intent-phrased task about a recorded trap gets one topical line, not a blank', () => {
  for (const [task, id] of [[SOFT_MCP, 'cairn-0043'], [TRAP_SHAPED, 'cairn-0043']] as const) {
    const entries = briefEntries(task, corpus, { useLocalEnvironment: true });
    assert.equal(entries.length, 1, `${task}: exactly one topical entry`);
    assert.equal(entries[0].id, id);
    assert.equal(entries[0].tier, 'topical');
    const text = brief(task, corpus, { useLocalEnvironment: true });
    assert.match(text, new RegExp(`${id} — .* — a weak but topical match on your task, not a verdict`));
    assert.doesNotMatch(text, /WHAT HAPPENS:/, 'one line, never the full block');
  }
});

/*
 * cairn-0001 carries `precondition: ["env:HTTPS_PROXY"]`, and the brief
 * evaluates preconditions against THIS process's environment. On a box with a
 * proxy (this sandbox, the crews' sandboxes) it is the top hit and topical;
 * on a box without one (the CI runner — the failure on run 34600317497) the
 * retriever drops it as provably inapplicable and the next hit, 0031 on
 * "agent"/"service", is NOT topical. The first version of this test asserted
 * the proxied answer without saying so and failed exactly where HTTPS_PROXY
 * was unset. Both environments are pinned now, explicitly, so the test says
 * what it depends on instead of inheriting it from whoever runs it.
 */
function withProxyEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
  for (const k of ['HTTPS_PROXY', 'https_proxy'] as const) {
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
  try {
    return fn();
  } finally {
    for (const k of ['HTTPS_PROXY', 'https_proxy'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('brief and find agree on the proxy/403 paraphrase ON A PROXIED BOX: cairn-0001 comes back, as a topical line', () => {
  withProxyEnv('http://127.0.0.1:9', () => {
    const entries = briefEntries(PROXY_PARAPHRASE, corpus, { useLocalEnvironment: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'cairn-0001');
    assert.equal(entries[0].tier, 'topical');
  });
});

test('on a box with no proxy the precondition drops cairn-0001, and the runner-up does not become a false topical nag', () => {
  withProxyEnv(undefined, () => {
    const entries = briefEntries(PROXY_PARAPHRASE, corpus, { useLocalEnvironment: true });
    assert.deepEqual(entries, [], `expected silence without a proxy, got ${entries.map((e) => `${e.id}/${e.tier}`).join(', ')}`);
  });
});

test('ordinary English that shares two rare-ish tokens with the corpus is NOT topical (the third crew\'s false nags)', () => {
  for (const task of ['Stripe Checkout vs custom form', 'LinkedIn post kill-vs-ship']) {
    const entries = briefEntries(task, corpus, { useLocalEnvironment: true });
    assert.deepEqual(entries, [], `${task}: fired ${entries.map((e) => `${e.id}/${e.tier}`).join(', ')}`);
    assert.equal(brief(task, corpus, { useLocalEnvironment: true }), '');
  }
});

/*
 * The fourth crew's false nags. Both cleared the summed-information floor --
 * the Stripe one at 9.55, HIGHER than either true topical -- because their
 * distinctive terms ("choosing", "day", "form"; "ship", "page", "writing") are
 * each rare in this corpus while being jointly ordinary startup-speak. What
 * they share is that every one of those terms lands in a finding's workaround
 * or machine text, not in its own account of the trap. These pin the rule that
 * the account must carry the majority of the distinctive information, and the
 * short forms stay pinned as controls so a fix for the long form cannot regress
 * the short one.
 */
test('ordinary task prose that collides with a finding\'s WORKAROUND vocabulary is NOT topical (the fourth crew\'s false nags)', () => {
  const falseNags = [
    'writing a LinkedIn Company Page post about kill vs ship for founders',
    'choosing between Stripe Checkout and a custom card form for a 5-day sprint deliverable',
  ];
  for (const task of falseNags) {
    const entries = briefEntries(task, corpus, { useLocalEnvironment: true });
    assert.deepEqual(entries, [], `${task}: fired ${entries.map((e) => `${e.id}/${e.tier}`).join(', ')}`);
    assert.equal(brief(task, corpus, { useLocalEnvironment: true }), '');
  }
});

test('the controls that were already silent stay silent under the account-share rule', () => {
  const controls = [
    'planning a pricing A/B test for a 9 SaaS memo product on IndieHackers',
    'Pricing A/B on IH',
    'drafting a marketing blog about founder decision paralysis with no code',
    'marketing blog decision paralysis',
    'picking lunch for a five person offsite in Brooklyn',
    'picking lunch offsite',
    'raise vs bootstrap',
  ];
  const fired = controls.filter((t) => brief(t, corpus, { useLocalEnvironment: true }) !== '');
  assert.deepEqual(fired, [], `topical line fired on a control: ${fired.join(' | ')}`);
});

/*
 * The other half of the same rule: silencing the false nags must not silence
 * the true ones. Each of these was verified to fire at exactly this id and
 * tier BEFORE the account-share rule was added, so a future tightening that
 * costs any of them is a regression in delivery, not a precision win. The
 * proxy rows carry `precondition: ["env:HTTPS_PROXY"]` and are pinned to a
 * proxied box the same way the paraphrase test above is.
 */
test('true topical and strong briefs keep firing at the same id and tier', () => {
  const keep: Array<[string, string, BriefEntry['tier']]> = [
    ['wiring MCP tool with zod schema and the argument comes through undefined', 'cairn-0043', 'topical'],
    ['MCP tool undocumented args zod', 'cairn-0043', 'full'],
    ['App Router page shows stale time needs force-dynamic', 'cairn-0005', 'full'],
    ['.githooks not running after clone hooksPath inert', 'cairn-0047', 'full'],
    ['esbuild top-level await fails in cjs output', 'cairn-0041', 'full'],
    ['socket hang up from a reused keep-alive http agent', 'cairn-0051', 'full'],
  ];
  for (const [task, id, tier] of keep) {
    const entries = briefEntries(task, corpus, { useLocalEnvironment: true });
    assert.ok(entries.length > 0, `${task}: went blank`);
    assert.equal(entries[0].id, id, `${task}: top entry`);
    assert.equal(entries[0].tier, tier, `${task}: tier`);
  }
  withProxyEnv('http://127.0.0.1:9', () => {
    const proxied: Array<[string, string, BriefEntry['tier']]> = [
      ['connection refused reaching an external host from the agent', 'cairn-0001', 'topical'],
      ['curl CONNECT tunnel failed response 403 egress blocked but dig resolves', 'cairn-0001', 'full'],
    ];
    for (const [task, id, tier] of proxied) {
      const entries = briefEntries(task, corpus, { useLocalEnvironment: true });
      assert.ok(entries.length > 0, `${task}: went blank`);
      assert.equal(entries[0].id, id, `${task}: top entry`);
      assert.equal(entries[0].tier, tier, `${task}: tier`);
    }
  });
});

test('a topical line is never added to a strong brief, and a strong brief still renders the full block', () => {
  const entries = briefEntries(CLOCK, corpus, { useLocalEnvironment: true });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.tier !== 'topical'), 'strong findings are delivered as full/hint, not demoted');
  assert.match(brief(CLOCK, corpus, { useLocalEnvironment: true }), /WHAT HAPPENS:/);
});

test('the topical tier does not fire on genuinely-unknown tasks: one distinctive term is not topical', () => {
  const unknown = [
    UNRELATED,
    'add a dark mode toggle to the settings page',
    'write a python script to parse csv files',
    'refactor the react component to use hooks',
    'set up a postgres migration for the users table',
    'kubectl rollout restart deployment frontend',
    'implement rate limiting on the login endpoint',
    'fix the flaky integration test for the payment webhook',
  ];
  const fired = unknown.filter((t) => brief(t, corpus, { useLocalEnvironment: true }) !== '');
  assert.deepEqual(fired, [], `topical line fired on unknown work: ${fired.join(' | ')}`);
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
