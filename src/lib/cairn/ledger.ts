/**
 * The retrieval ledger — what was served, to whom, and what happened next.
 *
 * WHY THIS EXISTS
 *
 * This corpus records the outcome of CHECKS: somebody ran the command, it
 * confirmed or refuted. It has never recorded the outcome of RETRIEVALS. Every
 * query, every finding surfaced, every brief assembled and handed over —
 * discarded the instant it was served. A corpus that cannot see its own
 * delivery cannot learn from it, and every measurement of delivery in this
 * project so far has been a one-off harvested by hand.
 *
 * So: an append-only record of each retrieval, and where it is known, what
 * became of it.
 *
 * WHAT AN OUTCOME MEANS HERE, AND WHAT IT DOES NOT
 *
 *   served    the finding was returned. Nothing more is claimed.
 *   surfaced  it was returned FIRST, so the reader almost certainly saw it.
 *   helped    the reader went on to avoid the trap it describes.
 *   missed    the right finding existed and was not returned first.
 *   misled    it was surfaced confidently and the reader still failed.
 *
 * `helped` and `misled` are the only two that require knowing what happened
 * afterwards, and they are only available where something grades the work — a
 * trial harness, a test, a human saying so. Most real retrievals will carry
 * `served` and nothing else, and a design that only works when outcomes are
 * dense would be a design that never works.
 *
 * APPEND ONLY, ONE JSON OBJECT PER LINE. Rewriting history here would let a
 * later belief edit an earlier observation, which is the thing this whole
 * project exists to refuse.
 */
import fs from 'fs';
import path from 'path';
import { homePath } from './home';

export type Outcome = 'served' | 'surfaced' | 'helped' | 'missed' | 'misled';

export interface RetrievalRecord {
  /** RFC3339. */
  at: string;
  /** Who asked. A model id, an agent name, or 'cli' — never a person. */
  by: string;
  /** What they typed, verbatim. */
  query: string;
  /** What came back, best first. */
  returned: { id: string; rank: number; strength: 'strong' | 'weak' }[];
  /** Where the query came from: a trial name, a harvest task, 'interactive'. */
  source?: string;
  /**
   * Which run this retrieval belongs to.
   *
   * The edge this corpus most lacks is SEQUENCE — that hitting the allowlist
   * proxy leads to meeting the DNS bypass, that a Playwright path failure is
   * followed by the disk one. Nothing in the corpus expresses "what tends to
   * follow what", and no amount of ranking recovers it, because it is a fact
   * about how traps arrive rather than about how they are worded. Two queries
   * in one session are evidence of that edge; the same two queries from
   * different sessions are not, and without this field they are
   * indistinguishable.
   *
   * Recorded now because it costs one string and cannot be reconstructed later.
   */
  session?: string;
  /**
   * What became of it, when anything is known. Keyed by finding id so a single
   * retrieval can record that one finding helped and another misled.
   */
  outcomes?: Record<string, Outcome>;
  /** Free text from whatever graded it, so a verdict can be argued with. */
  note?: string;
  /**
   * True when `returned` was REPLAYED rather than captured.
   *
   * The trial transcripts kept the queries and not the tool results, so what
   * those agents were actually shown is gone. Replaying against today's index
   * recovers something useful and something different: the ranking as it is
   * now, attributed to a decision made under a ranking as it was. The outcomes
   * are real; the served list is a reconstruction, and anything reasoning from
   * it should know which half is which.
   */
  reconstructed?: boolean;
}

/*
 * ONE FILE PER AUTHOR, and this is not tidiness.
 *
 * The ledger is append-only and shared by pushing and pulling the repository,
 * which is the whole point of keeping it in git. A single file makes that
 * impossible: two people, one query each, and the next pull is a merge
 * conflict — measured, not predicted. It would have failed on the first day of
 * any multi-person test, in the file whose entire job is to record what
 * happened when several people used this.
 *
 * Sharded by author, two writers touch two files and git has nothing to
 * reconcile. `merge=union` in .gitattributes covers the remaining case of one
 * author on two machines, where concatenating both sides is exactly right for
 * an append-only log.
 *
 * The reader takes the union of every shard plus the historical single file,
 * so an older checkout keeps working and nothing has to be migrated to be read.
 */
/* Functions, not consts: see the note on cacheDir() in federation.ts. */
const ledgerDir = () => homePath('data', 'retrievals');
const legacyLedger = () => homePath('data', 'retrievals.jsonl');

/** Filesystem-safe, and stable for the same author across runs. */
function shardFor(by: string): string {
  const safe = by.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return path.join(ledgerDir(), `${safe}.jsonl`);
}

/**
 * Record one retrieval. Never throws: a corpus that fails to answer because it
 * could not write its diary is worse than one with an incomplete diary.
 */
/**
 * The longest query text any single row may carry.
 *
 * A backstop, not a policy: callers decide what to record, and this decides
 * what a mistake can cost. The gateway used to write every forwarded tool
 * call's full arguments here, and a bulk create of two thousand records
 * produced a 474 KB single JSONL line -- in 28ms, so nothing about it felt
 * wrong. In a committed, union-merged file. Whatever the caller intends, a
 * ledger row is a measurement, and no measurement needs two thousand records
 * of somebody's customer data to be countable.
 */
const MAX_QUERY_CHARS = 2000;

export function record(r: RetrievalRecord): void {
  try {
    const query =
      r.query.length > MAX_QUERY_CHARS
        ? `${r.query.slice(0, MAX_QUERY_CHARS)} [truncated ${r.query.length - MAX_QUERY_CHARS} chars]`
        : r.query;
    fs.mkdirSync(ledgerDir(), { recursive: true });
    fs.appendFileSync(shardFor(r.by), `${JSON.stringify({ ...r, query })}\n`);
  } catch {
    /* deliberately silent */
  }
}

function readOne(file: string): RetrievalRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no shard yet
  }
  /*
   * Parse PER LINE. A single torn line — a process killed mid-append leaves a
   * partial JSON line, and the next append glues onto it — used to throw inside
   * one try and discard the ENTIRE shard, so all of an author's history
   * (the gateway's is the big one) vanished from status/report/impact silently.
   * Skip the bad line, count it, keep the rest.
   */
  const out: RetrievalRecord[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RetrievalRecord);
    } catch {
      skipped++;
    }
  }
  if (skipped) process.stderr.write(`cairn: skipped ${skipped} unparseable line(s) in ${file}\n`);
  return out;
}

/** Every author's shard, plus the pre-shard file if it is still there. */
export function readLedger(file?: string): RetrievalRecord[] {
  if (file) return readOne(file);
  const out: RetrievalRecord[] = readOne(legacyLedger());
  try {
    for (const f of fs.readdirSync(ledgerDir())) {
      if (f.endsWith('.jsonl')) out.push(...readOne(path.join(ledgerDir(), f)));
    }
  } catch {
    /* no shards yet */
  }
  return out;
}

export const ledgerPath = ledgerDir;
