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
import { retrieve, tokenize, buildIndex } from '../src/lib/cairn/retrieval';
import { assertLocalCorpus } from '../src/lib/cairn/confirm';
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
