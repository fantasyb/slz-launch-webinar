/**
 * cairn:backfill-ledger — seed the retrieval ledger from real trials.
 *
 *   npm run cairn:backfill-ledger
 *
 * Forty-odd trials have already run in this project where an agent issued a
 * query, was served findings, and then measurably succeeded or failed. That is
 * query -> served -> outcome, which is precisely what a memory layer consumes,
 * and it was about to be thrown away with the temp files.
 *
 * HONESTY ABOUT WHAT IS RECOVERABLE. The transcripts kept the queries and not
 * the tool results, so what those agents were actually shown no longer exists.
 * The served list is replayed against today's index and every such record is
 * marked `reconstructed`. The OUTCOMES are real — they were graded at the time,
 * mechanically, by the harness.
 *
 * Idempotent: rewrites data/retrievals.jsonl from source rather than appending,
 * because running it twice should not double the evidence.
 */
import fs from 'fs';
import path from 'path';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';
import { ledgerPath, type Outcome, type RetrievalRecord } from '../src/lib/cairn/ledger';
import { longestVerbatimRun, VERBATIM_RUN_LIMIT } from '../src/lib/cairn/evalset';

const corpus = loadCorpus();

/*
 * THE LEDGER MAY NOT CONTAIN A QUERY THE SUITES SCORE.
 *
 * Memory derived from these records feeds ranking, and the suites measure that
 * ranking. The field suite was harvested from the very trial transcripts this
 * script reads, so without this filter memory would be built from the answers
 * to the exam and would raise the score by construction — an effect that looks
 * exactly like the system getting better.
 *
 * The same rule already governs the generated expansions, enforced by
 * cairn:lint. It governs this for the same reason.
 */
const EVAL_QUERIES: string[] = (() => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/field-queries.json'), 'utf8')) as {
        queries: { q: string }[];
      }
    ).queries.map((x) => x.q);
  } catch {
    return [];
  }
})();
let excluded = 0;
const isScored = (q: string) => {
  const hit = EVAL_QUERIES.some((e) => longestVerbatimRun(e, q) >= VERBATIM_RUN_LIMIT);
  if (hit) excluded++;
  return hit;
};

/** What each scenario's task was built around, from the trial harness. */
const GOLD: Record<string, string> = {
  staleness: 'cairn-0019',
  reachability: 'cairn-0001',
  clock: 'cairn-0005',
  braces: 'cairn-0003',
};

interface Trial {
  arm: string;
  trial: number;
  calls: string[];
  refused?: boolean;
  ok?: boolean;
  detail?: string;
}

const records: RetrievalRecord[] = [];

function fromTrials(file: string, scenario: string, model: string) {
  let trials: Trial[];
  try {
    trials = JSON.parse(fs.readFileSync(file, 'utf8')) as Trial[];
  } catch {
    return;
  }
  const gold = GOLD[scenario];
  for (const t of trials) {
    if (t.refused) continue;
    const queries = t.calls.filter((c) => c.startsWith('CAIRN:')).map((c) => c.replace(/^CAIRN:\s*/, ''));
    for (const q of queries) {
      if (isScored(q)) continue;
      const hits = retrieve(q, corpus, { limit: 5 });
      const returned = hits.map((h, i) => ({ id: h.finding.id, rank: i + 1, strength: h.strength }));
      const outcomes: Record<string, Outcome> = {};
      const top = returned[0];
      /*
       * Attributed only to the finding the task was built around. A query that
       * surfaced something else and succeeded says nothing about that something
       * else -- the agent may have ignored it entirely -- and inventing an
       * outcome for it would put fiction in the one record meant to hold facts.
       */
      if (gold) {
        if (top?.id === gold) outcomes[gold] = t.ok ? 'helped' : 'misled';
        else if (returned.some((r) => r.id === gold)) outcomes[gold] = 'missed';
        else outcomes[gold] = 'missed';
      }
      for (const r of returned) if (!outcomes[r.id]) outcomes[r.id] = r.rank === 1 ? 'surfaced' : 'served';
      records.push({
        at: new Date(fs.statSync(file).mtime).toISOString(),
        by: model,
        query: q,
        returned,
        source: `trial:${scenario}:${t.arm}`,
        session: `${scenario}:${model}:${t.arm}:${t.trial}`,
        outcomes,
        reconstructed: true,
        note: t.detail,
      });
    }
  }
}

function fromHarvest(file: string) {
  let rows: { task: string; about: string | null; q: string }[];
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof rows;
  } catch {
    return;
  }
  for (const r of rows) {
    if (isScored(r.q)) continue;
    const hits = retrieve(r.q, corpus, { limit: 5 });
    const returned = hits.map((h, i) => ({ id: h.finding.id, rank: i + 1, strength: h.strength }));
    /*
     * No outcome. The harvest grades nothing by design, and `served` is the
     * honest record of what happened: something came back and nobody checked.
     * Most real retrievals will look like this.
     */
    const outcomes: Record<string, Outcome> = {};
    for (const x of returned) outcomes[x.id] = x.rank === 1 ? 'surfaced' : 'served';
    records.push({
      at: new Date(fs.statSync(file).mtime).toISOString(),
      by: 'claude-opus-5',
      query: r.q,
      returned,
      source: `harvest:${r.task}`,
      session: `harvest:${r.task}`,
      outcomes,
      reconstructed: true,
    });
  }
}

fromTrials('/tmp/agent-trial-staleness.json', 'staleness', 'claude-opus-5');
fromTrials('/tmp/agent-trial-reachability.json', 'reachability', 'claude-opus-5');
fromTrials('/tmp/agent-trial-clock-claude-haiku-4-5.json', 'clock', 'claude-haiku-4-5');
fromTrials('/tmp/agent-trial-staleness-claude-haiku-4-5.json', 'staleness', 'claude-haiku-4-5');
fromHarvest('/tmp/harvest.json');

fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
fs.writeFileSync(ledgerPath(), records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));

const byOutcome = new Map<string, number>();
for (const r of records) for (const o of Object.values(r.outcomes ?? {})) byOutcome.set(o, (byOutcome.get(o) ?? 0) + 1);
console.log(`\n  ${records.length} retrievals -> ${ledgerPath()}`);
console.log(`  ${excluded} excluded: their query is scored by a suite, so memory may not see them.`);
for (const [o, n] of [...byOutcome].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${o}`);
const models = new Set(records.map((r) => r.by));
console.log(`\n  ${models.size} model(s): ${[...models].join(', ')}`);
console.log('  every row reconstructed: served lists replayed, outcomes real.\n');
