/**
 * cairn:field-eval — the only queries here that nobody wrote for an eval.
 *
 *   npm run cairn:field-eval
 *
 * Every other suite scores observation notes, which are written by the same
 * person as the finding they are scored against. That is held out of the index
 * and not out of the author, so it cannot measure the thing retrieval exists
 * for: two people describing one trap in different words. The queries here were
 * typed by agents doing a task, with no sight of the corpus, and harvested from
 * the trial transcripts afterwards.
 *
 * The negatives matter more than the positives. Eight of these have no answer
 * in the corpus — an agent wondering about timezone parsing or NaN comparators
 * mid-task — and a retriever that answers them confidently is worse than one
 * that misses, because a confident wrong finding is acted on. Both halves are
 * reported and neither is averaged into the other.
 */
import fs from 'fs';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';

interface FieldQuery {
  q: string;
  gold: string | null;
  repeats?: number;
  contaminated?: boolean;
  /** A null label a reasonable reader could dispute. Reported both ways. */
  arguable?: boolean;
  why?: string;
  task: string;
}

const { queries } = JSON.parse(fs.readFileSync('data/field-queries.json', 'utf8')) as {
  queries: FieldQuery[];
};
const corpus = loadCorpus();
const scored = queries.filter((x) => !x.contaminated);
const positives = scored.filter((x) => x.gold);
const negatives = scored.filter((x) => !x.gold);

console.log('\nFIELD QUERIES — typed by agents mid-task, never written for an eval');
console.log('='.repeat(72));

let p1 = 0;
let p5 = 0;
console.log('\n  ANSWERABLE — did the finding they needed come back, and first?\n');
for (const c of positives) {
  const hits = retrieve(c.q, corpus);
  const rank = hits.findIndex((h) => h.finding.id === c.gold);
  if (rank === 0) p1++;
  if (rank >= 0 && rank < 5) p5++;
  const mark = rank === 0 ? 'first ' : rank > 0 ? `#${rank + 1}    ` : 'ABSENT';
  const rep = c.repeats && c.repeats > 1 ? ` x${c.repeats}` : '';
  console.log(`  ${mark} ${c.gold}  ${c.q.slice(0, 62)}${rep}`);
}

/*
 * Quiet means: returned nothing at all, or returned only matches the retriever
 * itself labelled weak. Both leave the reader free to ignore it. A confident
 * top hit on a question the corpus cannot answer is the failure.
 */
let quiet = 0;
console.log('\n  UNANSWERABLE — nothing here answers these. Did it say so?\n');
for (const c of negatives) {
  const hits = retrieve(c.q, corpus);
  const top = hits[0];
  const isQuiet = !top || top.strength === 'weak';
  if (isQuiet) quiet++;
  const mark = isQuiet ? 'quiet ' : 'CLAIMS';
  console.log(`  ${mark} ${top ? `${top.finding.id}${top.strength === 'weak' ? ' (weak)' : ''}` : '—'}  ${c.q.slice(0, 58)}`);
}

console.log(`\n${'='.repeat(72)}`);
console.log(`  answerable   P@1 ${p1}/${positives.length} (${(p1 / positives.length).toFixed(3)})   P@5 ${p5}/${positives.length}`);
console.log(`  unanswerable quiet ${quiet}/${negatives.length} (${(quiet / negatives.length).toFixed(3)})`);
/*
 * Two null labels are disputable, and which way they fall moves both numbers.
 * Reporting one reading and calling it the answer would be choosing the story;
 * the band is the honest form.
 */
const arguable = negatives.filter((c) => c.arguable);
if (arguable.length) {
  const firm = negatives.filter((c) => !c.arguable);
  const firmQuiet = firm.filter((c) => {
    const top = retrieve(c.q, corpus)[0];
    return !top || top.strength === 'weak';
  }).length;
  console.log(`\n  ${arguable.length} of the unanswerable labels are disputable. Reading them the other way:`);
  console.log(`  unanswerable quiet ${firmQuiet}/${firm.length} (${(firmQuiet / firm.length).toFixed(3)}) — the rest counted as answerable and missed.`);
  for (const c of arguable) console.log(`    · ${c.q.slice(0, 66)}`);
}
/*
 * A record whose subject is this corpus competes in this corpus's own
 * evaluation, and cannot be prevented from doing so by writing it more
 * carefully — cairn-0039 stopped quoting these queries verbatim and still
 * intercepts three of them, because it is ABOUT eval queries and its
 * vocabulary is theirs. Excluding such records would be rigging the number.
 * Showing both is the same discipline as printing the band on the disputable
 * labels: the headline is the full corpus, and the decomposition says how much
 * of the miss is the retriever and how much is the ledger discussing itself.
 *
 * The list is declared in the data file, not derived. A predicate on
 * subject.name missed cairn-0039 — the very record doing the intercepting,
 * whose subject is 'retrieval evaluation' — and printed a decomposition
 * showing no effect, which is worse than printing none at all.
 */
const SELF_REFERENTIAL: string[] = (
  JSON.parse(fs.readFileSync('data/field-queries.json', 'utf8')) as { selfReferential?: string[] }
).selfReferential ?? [];
if (SELF_REFERENTIAL.length) {
  const narrowed = corpus.filter((f) => !SELF_REFERENTIAL.includes(f.id));
  const p = positives.filter((c) => retrieve(c.q, narrowed)[0]?.finding.id === c.gold).length;
  console.log(
    `\n  ${SELF_REFERENTIAL.length} records have this corpus as their subject. Without them: ` +
      `P@1 ${p}/${positives.length} (${(p / positives.length).toFixed(3)}).`,
  );
  console.log('  Reported, not applied — the headline is the corpus as it actually stands.');
}
console.log(`\nFIELD p1=${(p1 / positives.length).toFixed(4)} quiet=${(quiet / negatives.length).toFixed(4)} n=${positives.length}/${negatives.length}\n`);
