/**
 * cairn:history — search the reasoning, not just the corpus.
 *
 *   npm run cairn:history -- "did we try compression"
 *   npm run cairn:history -- "why did the cache go stale" --n 5
 *
 * WHY GIT IS THE DATABASE WE ALREADY HAD
 *
 * A vector store keeps ONE version of each chunk. Git keeps every version, who
 * wrote it, when, what changed alongside it, and -- in the message -- why.
 * Measured on this repository: 242KB of commit bodies against 184KB of
 * findings, and 10 to 12 revisions of a typical finding. There is more
 * recorded reasoning in the history than in the corpus it describes, and until
 * this script none of it answered a question.
 *
 * Most of it is negative results, which is precisely what this project exists
 * to keep. "Fused as a sixth ranking: 0.895 -> 0.816 at every weight." "RRF
 * discards margins, and the margin is the whole signal." Those cost real hours
 * and were written down carefully, and an agent about to try the same thing
 * had no way to learn it had already been tried.
 *
 * WHAT THIS IS NOT
 *
 * It is not a second corpus. A finding is a claim with a check, a half-life
 * and a precondition -- something that can be verified and can expire. A
 * commit is an immutable record of a decision, and it is true forever in the
 * only sense that matters: that is what happened, on that date, for that
 * reason. The two want different treatment, which is why this is a separate
 * command rather than more rows in the index.
 *
 * BM25 over commit bodies, deliberately. The retriever in retrieval.ts is
 * built around findings -- preconditions, decay, confusion pairs -- and none
 * of that applies here. Thirty lines of standard ranking over 145 documents
 * is the right size of tool for the job.
 */
import { execFileSync } from 'child_process';
import { tokenize } from '../src/lib/cairn/retrieval';

const SEP = '\x1e';
const raw = execFileSync('git', ['log', `--format=%H${SEP}%ad${SEP}%s${SEP}%b${SEP}`, '--date=short'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const commits = raw.split(`${SEP}\n`).filter(Boolean).map((c) => {
  const [sha, date, subject, body] = c.split(SEP);
  return { sha: (sha ?? '').trim().slice(0, 8), date, subject, body: body ?? '' };
}).filter((c) => c.sha);

const docs = commits.map((c) => ({
  ...c,
  terms: (() => {
    const m = new Map<string, number>();
    for (const t of tokenize(`${c.subject}\n${c.body}`)) m.set(t.text, (m.get(t.text) ?? 0) + 1);
    return m;
  })(),
}));
const N = docs.length;
const df = new Map<string, number>();
for (const d of docs) for (const t of d.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
const avgdl = docs.reduce((a, d) => a + [...d.terms.values()].reduce((x, y) => x + y, 0), 0) / N;

function ask(q: string, k: number) {
  const qt = [...new Set(tokenize(q).map((t) => t.text))];
  const scored = docs.map((d) => {
    const len = [...d.terms.values()].reduce((a, b) => a + b, 0);
    let s = 0;
    for (const t of qt) {
      const n = df.get(t) ?? 0; if (!n) continue;
      const f = d.terms.get(t) ?? 0; if (!f) continue;
      s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len / avgdl)));
    }
    return { d, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k);
  console.log(`\n  ? ${q}`);
  for (const { d, s } of scored) {
    const line = d.body.split('\n').find((l) => /\d\.\d{3}|->|revert|because/i.test(l))?.trim() ?? '';
    console.log(`    ${d.sha} ${d.date}  ${d.subject.slice(0, 62)}`);
    if (line) console.log(`             ${line.slice(0, 86)}`);
  }
  if (!scored.length) console.log('    (nothing in the history)');
}

const argv = process.argv.slice(2);
const nAt = argv.indexOf('--n');
const k = nAt >= 0 ? Number(argv[nAt + 1]) : 3;
const query = argv.filter((a, i) => a !== '--n' && (nAt < 0 || i !== nAt + 1)).join(' ').trim();

if (!query) {
  console.log(`\nusage: npm run cairn:history -- "<question>" [--n 5]`);
  console.log(`\n${N} commits indexed, ${df.size} distinct terms.`);
  console.log('Searches what was tried and why, including everything that was reverted.\n');
  process.exit(0);
}
ask(query, k);
console.log();
