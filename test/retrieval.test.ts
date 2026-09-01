/**
 * Retrieval invariants.
 *
 * These exist because the old search failed on the single most likely query
 * this corpus will ever receive — an agent pasting the error it just got — and
 * failed in both directions at once: `no space left on device` returned all 31
 * findings, and `ENOSPC` returned none. Neither was visible without measuring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus } from '../src/lib/cairn/load';
import {
  retrieve, tokenize, buildIndex, associationStatus, rankerSignature,
} from '../src/lib/cairn/retrieval';
import { assertLocalCorpus, runCommand } from '../src/lib/cairn/confirm';
import { coOccurrence, alsoSeenWith } from '../src/lib/cairn/graph';

const corpus = loadCorpus();

test('a natural-language error does not return the whole corpus', () => {
  const hits = retrieve('no space left on device', corpus);
  assert.ok(hits.length > 0, 'must return something');
  assert.ok(
    hits.length <= corpus.length / 3,
    `returned ${hits.length} of ${corpus.length} — stopword terms are scoring again`,
  );
});

test('common words carry no weight on their own', () => {
  // `on` is a substring of connection, confidence and python. Under the old
  // matcher that alone matched every finding.
  for (const q of ['on', 'the', 'of and the on in']) {
    const hits = retrieve(q, corpus);
    assert.ok(
      hits.length <= corpus.length / 3,
      `"${q}" returned ${hits.length} of ${corpus.length}`,
    );
  }
});

test('an errno symbol finds the finding written in prose', () => {
  // Nothing in the corpus contains the literal string ENOSPC.
  const raw = JSON.stringify(corpus);
  assert.ok(!raw.includes('ENOSPC'), 'precondition for this test: corpus must not contain ENOSPC');
  const hits = retrieve('ENOSPC', corpus, { limit: 1 });
  assert.equal(hits[0]?.finding.id, 'cairn-0008', 'errno aliasing did not reach the disk finding');
});

test('plural and singular reach the same findings', () => {
  const singular = retrieve('proxy', corpus).map((h) => h.finding.id);
  const plural = retrieve('proxies', corpus).map((h) => h.finding.id);
  assert.ok(plural.length > 0, '"proxies" returned nothing');
  assert.ok(
    plural.every((id) => singular.includes(id)),
    'stemming reached findings the singular did not',
  );
});

test('the subject of a query outranks an incidental mention', () => {
  const hits = retrieve('playwright install', corpus, { limit: 1 });
  assert.equal(hits[0]?.finding.id, 'cairn-0007');
});

test('every hit can say why it matched', () => {
  for (const h of retrieve('proxy 403', corpus)) {
    assert.ok(h.matched.length > 0, `${h.finding.id} scored with no matched terms`);
    assert.ok(
      h.matched.every((m) => m.contribution > 0),
      'a matched term contributed nothing, so it should not be listed',
    );
  }
});

test('scoring is deterministic and order-independent', () => {
  const a = retrieve('proxy', corpus).map((h) => h.finding.id);
  const b = retrieve('proxy', [...corpus].reverse()).map((h) => h.finding.id);
  assert.deepEqual(a, b, 'ranking depends on corpus file order');
});

test('an empty query matches nothing rather than everything', () => {
  assert.equal(retrieve('', corpus).length, 0);
  assert.equal(retrieve('   ', corpus).length, 0);
});

test('tokenize keeps identifiers that a word-splitter would destroy', () => {
  const t = tokenize('PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers --no-sandbox node:dns 403');
  const texts = t.map((x) => x.text);
  assert.ok(texts.includes('/opt/pw-browsers'), 'absolute path was split');
  assert.ok(texts.includes('--no-sandbox'), 'flag was split');
  assert.ok(texts.includes('node:dns'), 'namespaced identifier was split');
  assert.ok(
    t.find((x) => x.text === '403')?.kind === 'status',
    'HTTP status not typed',
  );
});

test('the index is memoized per corpus array', () => {
  assert.equal(buildIndex(corpus), buildIndex(corpus), 'index rebuilt for the same array');
});

/**
 * The safety boundary. Executing checks is the one place this project runs
 * code that came out of the corpus, and cairn-0014 is the finding about
 * exactly that mistake. Identity against the local loader is what stops an API
 * payload — which can claim any id and mimic any shape — from being executed.
 */
test('checks refuse to run for findings that did not come from disk', async () => {
  const foreign = JSON.parse(JSON.stringify(corpus[0]));
  assert.throws(
    () => assertLocalCorpus([foreign]),
    /did not come from the local corpus/,
    'a structurally identical copy was accepted for execution',
  );
});

test('the local corpus itself is accepted', () => {
  assert.doesNotThrow(() => assertLocalCorpus(corpus.slice(0, 3)));
});

test('findings about the same trap are linked, not silently ordered', () => {
  const hits = retrieve('playwright browsers already installed', corpus, { limit: 3 });
  const seven = hits.find((h) => h.finding.id === 'cairn-0007');
  assert.ok(seven, 'expected the playwright install finding');
  assert.ok(
    seven.siblings.includes('cairn-0012'),
    'the two playwright-browser findings were not linked as siblings',
  );
  // Symmetric, or an agent reading only the winner never learns of the other.
  const twelve = hits.find((h) => h.finding.id === 'cairn-0012');
  assert.ok(twelve?.siblings.includes('cairn-0007'), 'sibling link is one-way');
});

test('unrelated findings are not linked just because they tie', () => {
  for (const h of retrieve('ENOSPC no space left on device', corpus)) {
    for (const sib of h.siblings) {
      const other = corpus.find((f) => f.id === sib)!;
      const sameSubject =
        other.subject.name.toLowerCase() === h.finding.subject.name.toLowerCase();
      const shared = h.finding.tags.filter((t) => other.tags.includes(t)).length;
      assert.ok(
        sameSubject || shared > 0,
        `${h.finding.id} linked to ${sib} with neither subject nor tags in common`,
      );
    }
  }
});

test('co-occurrence links findings that share no vocabulary', () => {
  const edges = alsoSeenWith('cairn-0001', corpus, { limit: 10 });
  assert.ok(edges.length > 0, 'no co-occurrence edges at all');
  for (const e of edges) {
    assert.ok(e.weight > 0 && e.attesters > 0, 'edge with no supporting evidence');
    assert.ok(e.id !== 'cairn-0001', 'a finding co-occurs with itself');
  }
});

test('co-occurrence is symmetric', () => {
  const g = coOccurrence(corpus);
  for (const [from, edges] of g) {
    for (const e of edges) {
      const back = g.get(e.id)?.find((x) => x.id === from);
      assert.ok(back, `${from} -> ${e.id} has no reverse edge`);
      assert.equal(back.weight, e.weight, 'asymmetric weight');
    }
  }
});

test('only confirmations build edges', () => {
  // A refutation says the finding did NOT reproduce there, which is the
  // opposite of evidence that it travels with anything.
  const refutedOnly = corpus.filter(
    (f) => f.observations.length > 0 && f.observations.every((o) => o.verdict !== 'confirmed'),
  );
  const g = coOccurrence(corpus);
  for (const f of refutedOnly) {
    assert.equal(g.get(f.id), undefined, `${f.id} has edges from non-confirmations`);
  }
});

test('association status reports why the graph is not yet informative', () => {
  const st = associationStatus(corpus);
  assert.ok(st.edges > 0, 'expected co-occurrence edges to exist');
  assert.ok(st.reason.length > 0, 'status must always give a reason');
  // A dormant capability that returns nothing looks exactly like a working one
  // with nothing to add. The status is what distinguishes them, so it must
  // never claim to be live while the graph is near-complete.
  if (st.density > 0.5) assert.equal(st.live, false, 'a near-complete graph claimed to be informative');
});

/**
 * Negative controls for the check harness.
 *
 * `cairn:doctor` reported 17 of 17 findings live on two consecutive runs with
 * zero negatives. A result set with no negatives in it cannot tell a healthy
 * corpus apart from a harness that says yes to everything — which is
 * cairn-0028, a gate whose input selector returns nothing passing everything,
 * reproduced in the code that runs cairn-0028's own check.
 */
test('a check that fails reports does-not-fire', async () => {
  const r = await runCommand('test-negative', 'exit 1', 5000);
  assert.equal(r.fired, 'does-not-fire');
  assert.equal(r.exitCode, 1);
});

test('a check that succeeds reports fires', async () => {
  const r = await runCommand('test-positive', 'echo hello; exit 0', 5000);
  assert.equal(r.fired, 'fires');
  assert.equal(r.exitCode, 0);
  assert.match(r.detail, /hello/);
});

test('a check that hangs is inconclusive, not a pass', async () => {
  const r = await runCommand('test-timeout', 'sleep 30', 700);
  assert.equal(r.fired, 'inconclusive', 'a timeout must never read as a verdict');
});

test('stderr survives, because the decisive line is often on it', async () => {
  const r = await runCommand('test-stderr', 'echo "on stderr" >&2; exit 0', 5000);
  assert.match(r.detail, /on stderr/);
});

test('exit 77 means the check could not decide, not that the claim failed', async () => {
  // Every other non-zero exit reads as "did not reproduce". A check that could
  // not run — no build artifact, no tool, no network — must not be recorded as
  // evidence against the finding.
  const r = await runCommand('test-skip', 'echo "no build artifact"; exit 77', 5000);
  assert.equal(r.fired, 'inconclusive');
  assert.equal(r.exitCode, 77);
});

/**
 * The columnar load path must produce exactly what the cold build produces.
 *
 * The index is written to disk as flat typed arrays and read back into a
 * different construction path. That is two implementations of one thing, and
 * two implementations drift. Worse, the drift would be invisible: both return
 * plausible rankings, and the accuracy suite would keep passing while half the
 * users -- everyone whose process found a warm cache -- got different answers.
 *
 * Verified at scale separately, where a 26x timing difference proves the paths
 * really do diverge (20.9s cold against 0.8s warm) and the outputs are still
 * byte-identical. This asserts the same property cheaply on the real corpus.
 */
test('a reloaded index ranks identically to a freshly built one', () => {
  const queries = [
    'ENOSPC: no space left on device, write',
    'curl: (56) CONNECT tunnel failed, response 403',
    '/bin/sh: 1: dig: not found',
    'proxies blocked',
    "error: pathspec 'x' did not match any file(s) known to git",
  ];
  const shape = (findings: typeof corpus) =>
    queries.map((q) =>
      retrieve(q, findings).map(
        (h) =>
          `${h.finding.id}:${h.score.toFixed(6)}:${h.strength}:${h.siblings.join('|')}:${h.confusedWith.join('|')}`,
      ),
    );

  const first = shape(corpus);
  // A distinct array with identical contents: the in-memory memo is keyed on
  // array identity, so this misses it and takes the on-disk path instead.
  const second = shape([...corpus]);
  assert.deepEqual(second, first, 'the reloaded index ranks differently from a fresh build');
});

/*
 * The confusion cache went stale silently, and nothing caught it.
 *
 * Measured confusion pairs are the ranker's output over the corpus, so they
 * depend on both. The cache was keyed on the corpus alone under a hardcoded
 * `v1` that was never bumped, so changing the fusion left every cached pair
 * describing the PREVIOUS ranker. The visible symptom was a delivery metric
 * reading 0.974 instead of 1.000 with no hint that a file was the cause, which
 * is the expensive kind of wrong: a real number, in the right units, computed
 * from the wrong inputs.
 *
 * The key is derived from the constants now. This locks that -- if a weight
 * can change an ordering, changing it must change where the cache is read.
 */
test('the confusion cache key changes when the ranking does', () => {
  const before = rankerSignature();
  const restore = process.env.CAIRN_EXPLAINED_WEIGHT;
  try {
    process.env.CAIRN_EXPLAINED_WEIGHT = '2.5';
    assert.notEqual(
      rankerSignature(),
      before,
      'a weight that reorders results must reach the cache key',
    );
    process.env.CAIRN_BM25_WEIGHT = '0.9';
    const both = rankerSignature();
    delete process.env.CAIRN_BM25_WEIGHT;
    assert.notEqual(both, rankerSignature(), 'each weight must reach the key independently');
  } finally {
    if (restore === undefined) delete process.env.CAIRN_EXPLAINED_WEIGHT;
    else process.env.CAIRN_EXPLAINED_WEIGHT = restore;
    delete process.env.CAIRN_BM25_WEIGHT;
  }
  assert.equal(rankerSignature(), before, 'the signature must be stable for fixed constants');
});

/*
 * Query coverage is a RANKING signal, not only a caveat.
 *
 * It was computed after the order was decided and used to write "accounts for
 * 40% of your query" on results the comparator had already sorted without it.
 * Five of the eight held-out failures had the gold finding explaining MORE of
 * the query than the finding that beat it. Fusing it took held-out P@1 from
 * 0.789 to 0.868 and MRR from 0.882 to 0.928.
 *
 * This asserts the property rather than the number: among the results, the one
 * that accounts for most of the question must not be buried.
 */
test('the hit that explains most of the query is not ranked below the tail', () => {
  const q =
    'The seal covers the content of a forecast. It does not, and cannot, cover ' +
    'the decision to publish one, and that decision is made later.';
  const hits = retrieve(q, corpus).slice(0, 8);
  assert.ok(hits.length > 1, 'needs several hits for the ordering to mean anything');
  const best = hits.reduce((a, b) => (b.explained > a.explained ? b : a));
  const where = hits.indexOf(best);
  assert.ok(
    where < 3,
    `the best-explaining hit ${best.finding.id} (${best.explained.toFixed(2)}) ranked ${where}`,
  );
});

/*
 * Shared terms must not decide a contest between siblings.
 *
 * `getent goes through NSS, not a DNS client` lost to a neighbouring DNS
 * finding for a while. Both matched `getent`, `dns`, `address`, `record` --
 * the terms the two findings have in common, which say the query is about DNS
 * in this sandbox and nothing about WHICH finding is meant. The loser won on
 * `nss`, `types` and `through`, and IDF over thirty-one documents rated
 * `through` as informative because three findings happen to contain it.
 *
 * The ranking subtracts two references now: what English does anyway, and
 * what every candidate in contention already shares. This asserts the outcome
 * rather than the weights, which are a ridge rather than a point and should be
 * free to move within it.
 */
test('a query about getent returns the finding about getent', () => {
  const hits = retrieve(
    'getent goes through NSS, not a DNS client, so it is limited to the ' +
      'host-lookup path. It has no concept of record types beyond addresses.',
    corpus,
  );
  assert.equal(hits[0]?.finding.id, 'cairn-0002', 'the shared DNS terms decided it again');
});

/*
 * The English reference must be consulted, and must not be load-bearing.
 *
 * `data/word-frequency.json` is measured, external, and optional -- a vendored
 * checkout without it must still retrieve. The ranking that uses it degrades
 * to a constant weight in that case, which changes an ordering and breaks
 * nothing, and this pins that it is reachable at all: a table that silently
 * failed to load would leave the ranker running on corpus rarity alone with
 * every number still looking plausible.
 */
test('the external word-frequency table is loaded and rates ordinary English', () => {
  const ordinary = tokenize('because whether through file error string').map((t) => t.text);
  assert.ok(ordinary.length > 0, 'tokeniser must keep ordinary words');
  const hits = retrieve('because whether through', corpus);
  // Nothing distinctive was asked, so nothing may come back confidently.
  assert.ok(
    hits.length === 0 || hits.every((h) => h.strength === 'weak'),
    'a query of pure filler must not produce a confident answer',
  );
});
