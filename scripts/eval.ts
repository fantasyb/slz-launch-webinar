/**
 * cairn:eval — measure retrieval accuracy against held-out ground truth.
 *
 *   npm run cairn:eval
 *
 * Retrieval quality is easy to believe you have improved and hard to know you
 * have. Every anecdote in this file's history was a query somebody had already
 * tuned against, which measures memory rather than accuracy. So accuracy is
 * measured the way the corpus measures its own claims: against data the thing
 * being tested has not seen.
 *
 * THE HELD-OUT SPLIT, AND THE FACT THAT IT CHANGED
 * ------------------------------------------------
 * It used to be `mechanism` and `appliesTo` — author prose explaining why a
 * finding is true, deliberately unindexed. Those are INDEXED now, and the
 * split is observation notes and prediction reasoning instead: text written
 * ABOUT a finding by people who ran its check or forecast its outcome, which
 * is closer to a real query than author prose ever was. The full reasoning,
 * including the quotation filter that keeps a note from scoring against text
 * it is copying, is in src/lib/cairn/evalset.ts.
 *
 * NUMBERS FROM BEFORE 2026-09-01 ARE NOT COMPARABLE TO NUMBERS AFTER IT. The
 * same retriever scores 0.895 on the old split and 0.836 on the new one. The
 * new split is harder and more honest: 67 cases instead of 38, and every one
 * of them is somebody describing an encounter in their own words.
 *
 * The former split is still reported, clearly marked in-sample, scoring 1.000.
 * That number measures nothing — it is text the retriever has read. It is kept
 * for the same reason `evidence` is: a sharp drop there means indexing broke.
 *
 * WHAT THE NUMBERS MEAN
 *   P@1  the right finding was first. What an agent taking one answer gets.
 *   P@5  the right finding was on the first page.
 *   MRR  1/rank, averaged. Sensitive to near-misses in a way P@1 is not.
 *
 * READ THIS BEFORE TUNING AGAINST IT
 * ----------------------------------
 * 67 cases is few enough that repeated tuning fits the ranker to this set
 * rather than to retrieval, and the number stops meaning anything without ever
 * looking like it stopped meaning anything. `npm run cairn:quick -- --folds 5`
 * exists to catch exactly that: a real gain moves every fold, a fitted one
 * moves the fold holding the cases it was built from.
 *
 * Attempts already spent against the OLD split, so the next person can count
 * honestly rather than starting from zero. These are kept because the failures
 * are still informative, not because the numbers carry over:
 *
 *   1. index `evidence`            0.650 -> (evidence left the held-out set)
 *   2. bigram / phrase matching    0.692 -> 0.641, reverted
 *   3. coverage counting fix       0.641 -> 0.667, still below baseline
 *   4. BM25 length normalisation   0.711 -> 0.763
 *   5. fuse BM25's ordering        0.763 -> 0.789
 *   6. fuse query coverage         0.789 -> 0.868, MRR 0.882 -> 0.928
 *   7. fuse strong-field coverage  0.868 -> 0.711, reverted
 *   8. subtract English globally   0.868 -> 0.816, reverted alone
 *   9. + subtract the shared       0.868 -> 0.895, MRR 0.928 -> 0.941
 *  10. nine further attempts at the sibling residual, all reverted; see the
 *      block comment in retrieval.ts for why the family is closed.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';
import { heldOutCases, inSampleCases } from '../src/lib/cairn/evalset';

const all = loadCorpus();

interface Case {
  q: string;
  gold: string;
  source: string;
  heldOut: boolean;
}

/*
 * Retired findings are not gold.
 *
 * Retrieval deliberately demotes them: a retired finding stopped being true,
 * and surfacing it beside live ones is how a withdrawn claim gets acted on.
 * Scoring the ranker against them measures it being punished for correct
 * behaviour — cairn-0010 sat at rank 10 and counted as an outright miss, which
 * is exactly where it belongs and exactly what the metric should not call an
 * error.
 */
const cases: Case[] = [
  ...heldOutCases(all).map((c) => ({ ...c, source: `held-out.${c.source}` })),
  ...inSampleCases(all).map((c) => ({ ...c, source: 'in-sample.mechanism+appliesTo' })),
];

interface Bucket {
  n: number;
  p1: number;
  p5: number;
  rr: number;
  misses: Case[];
}
const buckets = new Map<string, Bucket>();

for (const c of cases) {
  const rank = retrieve(c.q, all).findIndex((h) => h.finding.id === c.gold);
  const b = buckets.get(c.source) ?? { n: 0, p1: 0, p5: 0, rr: 0, misses: [] };
  b.n++;
  if (rank === 0) b.p1++;
  if (rank >= 0 && rank < 5) b.p5++;
  if (rank >= 0) b.rr += 1 / (rank + 1);
  else b.misses.push(c);
  buckets.set(c.source, b);
}

/*
 * Delivery, not rank.
 *
 * P@1 asks whether the right finding came first. That is the wrong question
 * for a consumer that reads a whole result set: an agent handed cairn-0007
 * with "often confused with cairn-0012" has been told about cairn-0012, and
 * scoring that as a miss measures a ranking convention rather than whether the
 * knowledge arrived.
 *
 * So this counts the finding as delivered when it ranks first OR the top hit
 * names it, through either the declarative sibling link or the measured
 * confusion link. It is the number that corresponds to what the agent knows
 * after one query.
 */
function delivery(): { n: number; first: number; delivered: number } {
  let n = 0, first = 0, delivered = 0;
  for (const c of heldOutCases(all)) {
    n++;
    const hits = retrieve(c.q, all);
    if (hits[0]?.finding.id === c.gold) { first++; delivered++; continue; }
    const top = hits[0];
    if (top && (top.siblings.includes(c.gold) || top.confusedWith.includes(c.gold))) delivered++;
  }
  return { n, first, delivered };
}

function report(title: string, sources: string[]) {
  const rows = sources.map((s) => [s, buckets.get(s)] as const).filter(([, b]) => b);
  if (rows.length === 0) return null;
  console.log(`\n${title}`);
  console.log('  source              n     P@1     P@5     MRR');
  console.log('  ' + '-'.repeat(46));
  let N = 0, P1 = 0, P5 = 0, RR = 0;
  for (const [s, b] of rows) {
    if (!b) continue;
    console.log(
      `  ${s.padEnd(18)}${String(b.n).padStart(3)}` +
        `${(b.p1 / b.n).toFixed(3).padStart(8)}${(b.p5 / b.n).toFixed(3).padStart(8)}` +
        `${(b.rr / b.n).toFixed(3).padStart(8)}`,
    );
    N += b.n; P1 += b.p1; P5 += b.p5; RR += b.rr;
  }
  console.log('  ' + '-'.repeat(46));
  console.log(
    `  ${'TOTAL'.padEnd(18)}${String(N).padStart(3)}` +
      `${(P1 / N).toFixed(3).padStart(8)}${(P5 / N).toFixed(3).padStart(8)}` +
      `${(RR / N).toFixed(3).padStart(8)}`,
  );
  return { N, P1, P5, RR };
}

const held = report(
  'HELD OUT — the honest number (observation notes and prediction reasoning are not indexed)',
  ['held-out.observation', 'held-out.prediction'],
);
report(
  'IN-SAMPLE — measures nothing, kept as a regression tripwire',
  ['in-sample.mechanism+appliesTo'],
);

const misses = [...buckets].flatMap(([, b]) => b.misses).filter((m) => m.heldOut);
if (misses.length) {
  console.log('\nheld-out cases not retrieved at all:');
  for (const m of misses.slice(0, 8)) {
    console.log(`  ${m.gold} [${m.source}] ${JSON.stringify(m.q.slice(0, 72))}`);
  }
}

/*
 * A machine-readable line, emitted unconditionally and named.
 *
 * The guard used to scrape the first `TOTAL` row out of this report. That
 * happened to be the held-out one, and would have kept happening right up
 * until somebody reordered the sections, at which point the guard would have
 * read the IN-SAMPLE 1.000 and passed everything forever. The doctor grew an
 * unconditional SUMMARY line for the same reason; a gate that parses a human
 * report is a gate that depends on the report's layout.
 */
if (held) {
  console.log(
    `\nHELDOUT n=${held.N} p1=${(held.P1 / held.N).toFixed(4)} ` +
      `p5=${(held.P5 / held.N).toFixed(4)} mrr=${(held.RR / held.N).toFixed(4)}`,
  );
}

const d = delivery();
console.log(
  `\nDELIVERY  ${d.delivered}/${d.n} (${(d.delivered / d.n).toFixed(3)}) — the right finding ` +
    `reached the agent,\n          ranked first or named by the top hit. ` +
    `Ranked first alone: ${(d.first / d.n).toFixed(3)}.`,
);

if (held) {
  console.log(
    `\nHeld-out P@1 ${(held.P1 / held.N).toFixed(3)} over ${held.N} cases. ` +
      'Compare like for like: this number is only meaningful against\n' +
      'previous runs of the same split, and it drops if a field moves from held out to indexed.\n',
  );
}
