/**
 * A finding's cache identity must cover the keys it verifies against.
 *
 * WHAT BROKE. The index caches `confidence` on disk, per finding, under
 * entryKey(f) = sha256(JSON.stringify(f)). A federated finding carries the key
 * map its observations verify against, and confidence depends on it -- an
 * observation is `signed` only against a map holding its key under its label
 * (signing.ts:262). JSON.stringify renders a Map as `{}`. So two copies of one
 * finding with DIFFERENT key maps hashed identically while scoring
 * differently, and whichever process wrote the entry first decided what every
 * later reader saw, for an hour, from a file shared across processes.
 *
 * HOW IT WAS FOUND. `a reloaded index ranks identically to a freshly built
 * one` failed in the full suite and passed whenever its file ran alone: the
 * runner executes test files in parallel over one cache directory, and a
 * sibling file that had loaded the same findings WITH upstream keys had
 * already written their confidence. Moving the keys onto the finding fixed who
 * supplies them, not what identifies the record, so the hazard outlived that
 * refactor.
 *
 * WHY IT IS SHAPED LIKE THIS. Three earlier attempts could not fail. Asserting
 * through retrieve() never touched the disk store inside one process;
 * comparing a finding WITHOUT a keys property against one WITH ended up
 * distinguishing `absent` from `{}`, which JSON.stringify already does. The
 * collision needs two records that BOTH carry keys, with DIFFERENT maps, and
 * a path that really reads the entry store back. So:
 *
 *   - CAIRN_HOME is a temp directory, set before retrieval.ts is imported,
 *     because CACHE_DIR is fixed at import. That gives this test its own
 *     cache and takes the parallel runner out of the picture.
 *   - The two corpora differ in JSON ([A] against [B, filler]) so the
 *     COLUMNAR fast path misses on its own fingerprint and buildIndex falls
 *     through to the per-finding entry store, which is the cache under test.
 *   - The premise (the two maps really score differently) is asserted first,
 *     so a change that made them score alike could not turn this green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeKey, keyMap, signedFinding, finding, env } from './helpers';

/* Set before anything reads the corpus. It no longer has to precede the imports
 * -- cache paths are resolved on use now, not at load -- but this file wants its
 * own cache directory regardless, so the ordering stays. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cache-identity-'));
fs.mkdirSync(path.join(HOME, 'cairn'));
process.env.CAIRN_HOME = HOME;

/** One signed finding, then two copies that differ only in the map they carry. */
function pair() {
  const signer = makeKey('upstream-agent');
  const stranger = makeKey('somebody-else');
  const base = signedFinding(
    [{ key: signer, obs: { at: '2026-08-30T00:00:00.000Z', by: 'upstream-agent', verdict: 'confirmed', environment: env('linux') } }],
    { id: 'cairn-7001', title: 'the same record under two key maps', createdAt: '2026-08-30T00:00:00.000Z' },
  );
  const verifies = { ...base, keys: keyMap(signer) };
  const doesNot = { ...base, keys: keyMap(stranger) };
  assert.equal(JSON.stringify(verifies), JSON.stringify(doesNot), 'the premise: JSON cannot see the map');
  return { verifies, doesNot };
}

test('two findings with different key maps do not share a cached confidence', async () => {
  const { buildIndex } = await import('../src/lib/cairn/retrieval');
  const { confidence } = await import('../src/lib/cairn/decay');
  const { verifies, doesNot } = pair();

  const cA = confidence(verifies, new Date());
  const cB = confidence(doesNot, new Date());
  assert.ok(cA > cB, `the premise: verifying keys must raise confidence (${cA} vs ${cB})`);

  // First writer: computes and persists confidence for the verifying copy.
  const first = buildIndex([verifies]);
  assert.ok(Math.abs(first.docs[0].confidence - cA) < 1e-9, 'first build must score the copy it was given');

  // Second reader, different corpus shape, same record bytes, different map.
  // Without the key ids in entryKey this reads the first writer's number.
  const second = buildIndex([doesNot, finding({ id: 'cairn-7002', title: 'a filler record so the corpus fingerprint differs' })]);
  const doc = second.docs.find((d) => d.id === 'cairn-7001');
  assert.ok(doc, 'the record must be indexed');
  assert.ok(
    Math.abs(doc.confidence - cB) < 1e-9,
    `the entry store served another key map's confidence: got ${doc.confidence}, wanted ${cB} (the other map scores ${cA})`,
  );
});

/**
 * The same blindness in the other cache, and this one is consulted FIRST.
 *
 * corpusFingerprint (retrieval.ts, indexIdentity) also hashes
 * JSON.stringify(f) per finding, and the columnar file it names carries
 * confidence too (columnar.ts, fromColumnar). Two corpora that are the same
 * records under different key maps therefore share one columnar index, and
 * buildIndex returns it before the entry store is ever read -- so the fix to
 * entryKey is reachable only when this path misses. Marked todo rather than
 * skipped: it runs, it fails today, and the runner reports it without failing
 * the suite. Remove the marker when indexIdentity folds the key identity in.
 */
test('two corpora with the same records and different key maps do not share a columnar index', async () => {
  const { buildIndex } = await import('../src/lib/cairn/retrieval');
  const { confidence } = await import('../src/lib/cairn/decay');
  const { verifies, doesNot } = pair();
  const cB = confidence(doesNot, new Date());

  buildIndex([verifies]);
  const reread = buildIndex([doesNot]); // a distinct array: the in-memory memo misses, the disk does not
  assert.ok(
    Math.abs(reread.docs[0].confidence - cB) < 1e-9,
    `the columnar index served another key map's confidence: got ${reread.docs[0].confidence}, wanted ${cB}`,
  );
});
