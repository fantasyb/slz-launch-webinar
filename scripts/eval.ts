/**
 * cairn:eval — measure retrieval accuracy against held-out ground truth.
 *
 *   npm run cairn:eval
 *
 * Retrieval quality is the kind of thing that is easy to believe you have
 * improved and hard to know you have. Every anecdote in this file's history
 * was a query somebody had already tuned against, which measures memory rather
 * than accuracy. So accuracy is measured the way the corpus measures its own
 * claims: against data the thing being tested has not seen.
 *
 * THE HELD-OUT SPLIT
 * ------------------
 * `mechanism` and `appliesTo` are deliberately NOT indexed by retrieval.ts.
 * They are prose the author wrote explaining why a finding is true and where
 * it applies, they are never part of the searchable text, and they exist here
 * as a permanent evaluation set. Indexing them would raise these numbers and
 * destroy the only unbiased measurement in the project.
 *
 * `evidence` used to be held out too, and evaluating against it is what
 * revealed that not indexing it was the single largest accuracy defect: P@1
 * was 0.548, and every total miss was raw output with no prose in it —
 * `/dev/vda 252G 8.1G 29G 22% /` — which no weighting on the prose fields
 * could ever have reached. It is indexed now, so queries drawn from it are
 * reported separately and clearly marked: they measure nothing, because the
 * retriever has seen that exact text. They are kept only as a regression
 * tripwire.
 *
 * WHAT THE NUMBERS MEAN
 *   P@1  the right finding was first. What an agent taking one answer gets.
 *   P@5  the right finding was on the first page.
 *   MRR  1/rank, averaged. Sensitive to near-misses in a way P@1 is not.
 *
 * READ THIS BEFORE TUNING AGAINST IT
 * ----------------------------------
 * There are 39 cases. That is few enough that repeated tuning against them
 * fits the ranker to this set rather than to retrieval, and the number stops
 * meaning anything without ever looking like it stopped meaning anything.
 *
 * Attempts already spent against this split, so the next person can count
 * honestly rather than starting from zero:
 *
 *   1. index `evidence`            0.650 -> (evidence left the held-out set)
 *   2. bigram / phrase matching    0.692 -> 0.641, reverted
 *   3. coverage counting fix       0.641 -> 0.667, still below baseline
 *
 * A large improvement from here should be validated on cases this file has
 * never seen — observation notes and prediction reasoning are both unindexed
 * and could supply them — rather than on another pass over these.
 *
 * P@1 is also pessimistic in a specific, known way. Several residual failures
 * are the gold finding sitting at rank 1 behind a SIBLING about the same trap:
 * cairn-0012 behind cairn-0007, both about Playwright browsers; cairn-0017,
 * -0018 and -0020 behind cairn-0026, all about commitment schemes. An agent
 * handed the sibling has not been misled. P@5, at 0.974, is the better guide
 * to whether the right answer is reachable.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';

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
const cases: Case[] = [];
for (const f of all) {
  if (f.status === 'retired') continue;
  const mech = f.mechanism;
  if (mech && mech.length > 40)
    cases.push({ q: mech.slice(0, 240), gold: f.id, source: 'mechanism', heldOut: true });
  if (f.appliesTo && f.appliesTo.length > 30)
    cases.push({ q: f.appliesTo.slice(0, 240), gold: f.id, source: 'appliesTo', heldOut: true });
  for (const e of f.evidence ?? []) {
    const out = (e.output ?? '').trim();
    if (out.length >= 12)
      cases.push({ q: out.slice(0, 240), gold: f.id, source: 'evidence.output', heldOut: false });
    if (e.command && e.command.length > 4)
      cases.push({ q: e.command, gold: f.id, source: 'evidence.command', heldOut: false });
  }
}

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

const held = report('HELD OUT — the honest number (mechanism and appliesTo are not indexed)',
  ['mechanism', 'appliesTo']);
report('IN-SAMPLE — measures nothing, kept as a regression tripwire',
  ['evidence.output', 'evidence.command']);

const misses = [...buckets].flatMap(([, b]) => b.misses).filter((m) => m.heldOut);
if (misses.length) {
  console.log('\nheld-out cases not retrieved at all:');
  for (const m of misses.slice(0, 8)) {
    console.log(`  ${m.gold} [${m.source}] ${JSON.stringify(m.q.slice(0, 72))}`);
  }
}

if (held) {
  console.log(
    `\nHeld-out P@1 ${(held.P1 / held.N).toFixed(3)} over ${held.N} cases. ` +
      'Compare like for like: this number is only meaningful against\n' +
      'previous runs of the same split, and it drops if a field moves from held out to indexed.\n',
  );
}
