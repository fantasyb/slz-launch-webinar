/**
 * cairn:baseline — is any of this better than thirty lines of BM25?
 *
 *   npm run cairn:baseline
 *
 * Everything measured so far compared this retriever to ITSELF: does a change
 * beat the version before it. That answers whether an edit helped and says
 * nothing about whether the whole apparatus was worth building. A number that
 * only ever moves against its own history can drift a long way from the point.
 *
 * So: textbook BM25 over the same corpus, and the same two evaluations.
 *
 * THREE ARMS, CHOSEN TO SEPARATE TWO DIFFERENT CLAIMS
 *
 *   bm25          Standard Okapi BM25, k1=1.2 b=0.75, whitespace-and-lowercase
 *                 tokenisation. What a competent engineer writes in half an
 *                 hour. This is the honest competitor.
 *   bm25+tok      The same ranking, fed this project's tokeniser — typed
 *                 tokens, errno aliases, light stemming. Isolates what the
 *                 TOKENISATION contributes from what the RANKING contributes.
 *   cairn         The whole thing.
 *
 * If bm25 matches cairn on accuracy, the sophistication bought nothing and the
 * honest move is to delete it. That outcome is a real possibility and this
 * script exists to make it visible rather than avoidable.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve, tokenize } from '../src/lib/cairn/retrieval';
import { heldOutCases } from '../src/lib/cairn/evalset';
import type { Finding } from '../src/lib/cairn/schema';

const all = loadCorpus();

/** Same text the real retriever indexes, so the comparison is about method. */
function docText(f: Finding): string {
  return [
    f.title, f.claim, f.subject.name, f.subject.ecosystem, f.expectation, f.reality,
    f.workaround ?? '', f.check.command, f.check.confirmedIf, f.check.refutedIf,
    // Indexed as of the eval-set rebuild; the baseline must see what we see or
    // it is not a comparison.
    f.mechanism ?? '', f.appliesTo ?? '',
    ...f.tags,
    ...(f.evidence ?? []).flatMap((e) => [e.command ?? '', e.output ?? '']),
  ].join('\n');
}

/** Plain tokenisation: what BM25 is normally given. */
const plain = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
/** This project's tokeniser, stripped to bare terms. */
const rich = (s: string): string[] => tokenize(s).map((t) => t.text);

function buildBm25(tok: (s: string) => string[]) {
  /*
   * Term frequencies precomputed at INDEX time, not per query.
   *
   * The first version of this rebuilt a tf map for every document on every
   * query -- O(N x document length) per query -- and then "measured" cairn as
   * six times faster than BM25. That was not a result, it was a badly written
   * competitor, and reporting it would have been the most flattering mistake
   * available. Any real BM25 index precomputes this, exactly as the BM25 pass
   * inside retrieval.ts does, so the comparison is now like for like.
   */
  const docs = all.map((f) => {
    const terms = tok(docText(f));
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { f, terms, tf, length: terms.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docs.reduce((a, d) => a + d.terms.length, 0) / docs.length;
  const N = docs.length;
  const k1 = 1.2;
  const b = 0.75;

  return (query: string) => {
    const q = tok(query);
    const scored = docs.map((d) => {
      let s = 0;
      for (const t of new Set(q)) {
        const n = df.get(t) ?? 0;
        if (n === 0) continue;
        const f = d.tf.get(t) ?? 0;
        if (f === 0) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
      }
      return { id: d.f.id, s };
    });
    return scored.filter((x) => x.s > 0).sort((a, b2) => b2.s - a.s).map((x) => x.id);
  };
}

const arms: Array<[string, (q: string) => string[]]> = [
  ['bm25', buildBm25(plain)],
  ['bm25+tok', buildBm25(rich)],
  ['cairn', (q) => retrieve(q, all).map((h) => h.finding.id)],
];

// ---------- held-out accuracy: observation notes + prediction reasoning ----
const heldOut = heldOutCases(all);

console.log('\nBASELINE COMPARISON — same corpus, same evaluations');
console.log('='.repeat(64));
console.log(`\nHELD-OUT ACCURACY (${heldOut.length} cases the retriever has never seen)`);
console.log('  arm          P@1     P@5     MRR');
for (const [name, rank] of arms) {
  let p1 = 0, p5 = 0, rr = 0;
  for (const c of heldOut) {
    const r = rank(c.q).indexOf(c.gold);
    if (r === 0) p1++;
    if (r >= 0 && r < 5) p5++;
    if (r >= 0) rr += 1 / (r + 1);
  }
  const n = heldOut.length;
  console.log(
    `  ${name.padEnd(12)}${(p1 / n).toFixed(3)}   ${(p5 / n).toFixed(3)}   ${(rr / n).toFixed(3)}`,
  );
}

// ---------- the half that matters: silence on unknown ground ---------------
/*
 * BM25 has no concept of "nothing here is relevant" -- it ranks whatever it
 * has and returns the top of the list. That is not a defect of BM25, which was
 * built for document collections where SOMETHING is always the best answer.
 * It is a mismatch with this use: an agent asks when it is stuck, and a
 * confident irrelevant finding costs more than no finding.
 *
 * Both arms are given the same courtesy: a hit counts as "handled safely" if
 * nothing came back, or if everything that came back is labelled weak. BM25
 * cannot label, so for it the test is simply whether it stayed silent.
 */
const unknown: Array<[string, string]> = [
  ['python ImportError', 'Traceback (most recent call last): File "<string>", line 1, in <module> ModuleNotFoundError: No module named nonexistent_module_xyz'],
  ['git pathspec', "error: pathspec 'does-not-exist-branch-xyz' did not match any file(s) known to git"],
  ['permission denied', 'cat: /etc/gshadow: Permission denied'],
];
const covered: Array<[string, string]> = [
  ['curl 403', 'curl: (56) CONNECT tunnel failed, response 403'],
  ['rg braces', 'rg: regex parse error: (?:interface{}) repetition quantifier'],
  ['dig missing', '/bin/sh: 1: dig: not found'],
];

console.log('\nUNKNOWN GROUND — failures the corpus has no finding about');
console.log('  arm          handled safely   what it returned for each');
for (const [name, rank] of arms) {
  const outs: string[] = [];
  let safe = 0;
  for (const [label, q] of unknown) {
    if (name === 'cairn') {
      const hits = retrieve(q, all);
      const ok = hits.length === 0 || hits.every((h) => h.strength === 'weak');
      if (ok) safe++;
      outs.push(`${label}=${hits.length === 0 ? 'silent' : ok ? 'weak-labelled' : 'CONFIDENT ' + hits[0].finding.id}`);
    } else {
      const ids = rank(q);
      if (ids.length === 0) safe++;
      outs.push(`${label}=${ids.length === 0 ? 'silent' : 'CONFIDENT ' + ids[0]}`);
    }
  }
  console.log(`  ${name.padEnd(12)}${safe}/${unknown.length}              ${outs.join('  ')}`);
}

/*
 * The other distribution. The held-out set is author prose; this is machine
 * output, which is what production actually receives. Every arm is scored on
 * both, because a method that wins one and loses the other is a trade, not a
 * victory -- and reporting only the half that flatters is how a benchmark
 * stops being one.
 */
const machine: Array<[string, string, string]> = [
  ['ENOSPC', 'ENOSPC: no space left on device, write', 'cairn-0008'],
  ['no space prose', 'no space left on device', 'cairn-0008'],
  ['curl 403', 'curl: (56) CONNECT tunnel failed, response 403', 'cairn-0001'],
  ['rg braces', 'rg: regex parse error: (?:interface{}) repetition quantifier', 'cairn-0003'],
  ['dig missing', '/bin/sh: 1: dig: not found', 'cairn-0002'],
  ['nslookup', '/bin/sh: 1: nslookup: not found', 'cairn-0002'],
  ['df output', 'Filesystem Size Used Avail Use% Mounted on /dev/vda 252G 8.5G 29G 23% /', 'cairn-0008'],
  ['proxies', 'proxies blocked', 'cairn-0001'],
];
console.log('\nMACHINE OUTPUT — the query production actually receives');
console.log('  arm          P@1     detail');
for (const [name, rank] of arms) {
  let hit = 0;
  const misses: string[] = [];
  for (const [label, q, gold] of machine) {
    const top = rank(q)[0];
    if (top === gold) hit++;
    else misses.push(`${label}->${top ?? 'silent'}`);
  }
  console.log(
    `  ${name.padEnd(12)}${(hit / machine.length).toFixed(3)}   ` +
      (misses.length ? 'missed: ' + misses.join(' ') : 'all correct'),
  );
}

/*
 * Speed, on the same footing.
 *
 * Accuracy was compared and cost was not, which is half a comparison: a method
 * that wins by 8 points and costs 50x is not obviously the better choice. Both
 * arms are indexed once and then queried warm, so this measures retrieval
 * rather than start-up.
 *
 * Note what is being compared. The cairn arm CONTAINS a BM25 pass -- the two
 * rankers are fused -- so it cannot be faster than BM25 and is not claimed to
 * be. The number that matters is what the rest of the pipeline costs on top:
 * typed tokenisation, errno aliasing, length-normalised scoring, sibling
 * links, confusion links and the weak-match annotation.
 */
const speedQueries = machine.map(([, q]) => q);
console.log('\nSPEED (warm, index already built, 2000 queries each)');
console.log('  arm          mean per query');
for (const [name, rank] of arms) {
  for (let i = 0; i < 50; i++) rank(speedQueries[i % speedQueries.length]);
  const t = process.hrtime.bigint();
  const N = 2000;
  for (let i = 0; i < N; i++) rank(speedQueries[i % speedQueries.length]);
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / N;
  console.log(`  ${name.padEnd(12)}${ms.toFixed(4)} ms`);
}

console.log('\nCOVERED GROUND — failures the corpus documents');
console.log('  arm          top hit for each');
for (const [name, rank] of arms) {
  const outs = covered.map(([label, q]) => `${label}=${rank(q)[0] ?? 'silent'}`);
  console.log(`  ${name.padEnd(12)}${outs.join('  ')}`);
}
console.log();
