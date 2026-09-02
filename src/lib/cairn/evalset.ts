/**
 * The held-out evaluation split, defined once so every script measures the
 * same thing.
 *
 * WHY THIS FILE EXISTS
 *
 * The split used to be written out separately in eval.ts, baseline.ts and
 * quick.ts. They drifted, and a number quoted from one was compared against a
 * number produced by another more than once in this project's history. A split
 * is a definition, not a detail of a report.
 *
 * WHAT IS HELD OUT, AND WHY IT CHANGED
 *
 * `mechanism` and `appliesTo` were the held-out set for most of this project's
 * life: author prose explaining why a finding is true, never indexed, so a
 * query drawn from one measured retrieval rather than memory.
 *
 * They are now INDEXED, deliberately, and the trade is recorded in
 * retrieval.ts. They are the clearest explanatory prose a finding has, which
 * is exactly why they made a good eval set and exactly why withholding them
 * from real users was costing recall. This repository made the identical trade
 * once before with `evidence`, and indexing that was the single largest
 * accuracy gain ever measured here.
 *
 * The replacement is text written ABOUT a finding rather than BY its author as
 * part of it: observation notes, left by agents who ran the check, and
 * prediction reasoning, written before a forecast was resolved. Neither is
 * indexed. Both are closer to a real query than author prose ever was --
 * somebody describing an encounter with the trap, in their own words.
 *
 * CONTAMINATION, WHICH THE OLD SPLIT DID NOT HAVE
 *
 * `mechanism` prose appears nowhere else in a finding, so it was clean by
 * construction. Observation notes are not: people quote the error they saw,
 * and the error is in `evidence`, which is indexed. Scoring those would
 * measure string equality and report it as retrieval.
 *
 * So every candidate is checked for the longest run of words it shares
 * verbatim with the finding's indexed text, and runs of seven or more are
 * excluded. Measured over the 78 candidates: 42 share three words or more
 * (unavoidable -- they are about the same subject), 16 share five, 5 share
 * seven, 2 share ten. The distribution has a clear knee there, and the
 * excluded ones are recognisably quotations: `tsc reports TS2741: Property 'b'
 * is missing in type ...` at thirteen words.
 *
 * Texts naming a finding id outright are excluded too, for the obvious reason.
 *
 * WHAT THIS SPLIT DOES NOT COVER
 *
 * 68 cases across 27 of the 31 live findings. Four findings have no clean
 * held-out text at all and are therefore never the gold answer in this split.
 * That is a real coverage gap and the number should be read knowing it: the
 * split measures retrieval over most of the corpus, not all of it.
 */
import fs from 'fs';
import path from 'path';
import type { Finding } from './schema';
import { homePath } from './home';
import { DEFAULT_OBSERVATION_NOTE } from './submission';

/** Generated queries, if any have been produced. See scripts/expand.ts. */
function loadExpansions(): Record<string, string[]> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(homePath('data', 'expansions.json'), 'utf8'),
    ) as { expansions?: Record<string, string[]> };
    return raw.expansions ?? {};
  } catch {
    return {};
  }
}
const EXPANSIONS: Record<string, string[]> = loadExpansions();

export interface EvalCase {
  /** The query text, as a searcher would have it. */
  q: string;
  /** The finding it was written about. */
  gold: string;
  source: 'observation' | 'prediction';
  /** True for the split that is actually held out of the index. */
  heldOut: boolean;
}

/** Word-runs this long shared with indexed text mean the text is quoting it. */
export const VERBATIM_RUN_LIMIT = 7;

/**
 * Everything a query could match against — must mirror retrieval's view.
 *
 * Generated expansions are included, and that is not optional. The filter's
 * job is to drop a held-out candidate that quotes text the retriever can see;
 * expansions ARE text the retriever can see, so leaving them out would let the
 * split quietly rot as more were generated. Caught empirically on the first
 * trial run: a generated query for cairn-0003 shared a seven-word run with a
 * held-out note, because both quote the same error string.
 *
 * The consequence is worth stating plainly. Generating expansions SHRINKS the
 * held-out set, because some candidates stop being held out. That is the same
 * trade indexing `evidence` made, and it is the correct direction: a smaller
 * honest split beats a larger one measuring memorisation.
 */
export function indexedText(f: Finding): string {
  return [
    f.title, f.claim, f.subject.name, f.subject.ecosystem, f.expectation, f.reality,
    f.workaround ?? '', f.check.command, f.check.confirmedIf, f.check.refutedIf,
    f.mechanism ?? '', f.appliesTo ?? '', ...f.tags,
    ...(f.evidence ?? []).flatMap((e) => [e.command ?? '', e.output ?? '']),
    ...(EXPANSIONS[f.id] ?? []),
  ].join('\n').toLowerCase();
}

/** Longest run of consecutive words from `q` appearing verbatim in `doc`. */
export function longestVerbatimRun(q: string, doc: string): number {
  /*
   * BOTH SIDES LOWERCASED. The query was folded and the document was not, so
   * every run broke at the first capitalised word: an eval query present in a
   * document verbatim scored 5 instead of 10, under a limit of 7.
   *
   * This function is the leakage guard for the held-out split, for generated
   * expansions, and for the retrieval ledger. It was under-detecting
   * contamination in all three, silently and in the direction that flatters.
   */
  const haystack = doc.toLowerCase();
  const w = q.toLowerCase().split(/\s+/).filter(Boolean);
  let best = 0;
  for (let i = 0; i < w.length; i++) {
    for (let n = best + 1; i + n <= w.length; n++) {
      if (haystack.includes(w.slice(i, i + n).join(' '))) best = n;
      else break;
    }
  }
  return best;
}

/**
 * The held-out cases. Retired findings are excluded: retrieval deliberately
 * demotes them, and scoring against them measures the ranker being punished
 * for correct behaviour.
 */
/**
 * Text that says nothing about the finding it is attached to.
 *
 * `heldOutCases` harvests observation notes as queries, on the reasoning that
 * an attester describing what they saw writes in the words a searcher would
 * use. That holds for a note somebody wrote. It fails completely for a
 * DEFAULT note, which is identical across every finding that did not supply
 * one -- an unanswerable query by construction, and a guaranteed miss.
 *
 * It matters because of what it does at scale rather than what it did once.
 * The whole point of the record loop is that findings arrive continuously, so
 * without this every banked finding adds one impossible case and the held-out
 * scores decay linearly with adoption: the corpus getting used would look
 * exactly like the ranker getting worse. One finding recorded today cost P@1
 * 0.797 -> 0.787, P@5 0.905 -> 0.893 and MRR 0.850 -> 0.842, and displaced
 * nothing -- the ranking of every existing case was unchanged.
 *
 * Detected by repetition rather than by a list of known strings, so a new
 * default somebody adds later is caught without anyone remembering to.
 */
function boilerplate(all: Finding[]): Set<string> {
  /*
   * The submission default is excluded by name as well as by repetition,
   * because the repetition rule cannot see it until the SECOND finding
   * carries it — and the first one already cost P@1 0.797 -> 0.787.
   */
  const counts = new Map<string, number>([[DEFAULT_OBSERVATION_NOTE.toLowerCase(), 2]]);
  for (const f of all) {
    for (const o of f.observations) {
      const t = (o.note ?? '').trim().toLowerCase();
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([t]) => t));
}

export function heldOutCases(all: Finding[]): EvalCase[] {
  const shared = boilerplate(all);
  const cases: EvalCase[] = [];
  for (const f of all) {
    if (f.status === 'retired') continue;
    const doc = indexedText(f);
    const add = (raw: string | undefined, source: EvalCase['source']) => {
      const t = (raw ?? '').trim();
      /* Attached to more than one finding, so it identifies none of them. */
      if (shared.has(t.toLowerCase())) return;
      if (t.length <= 40) return;
      if (/cairn-\d{4}/i.test(t)) return;
      if (longestVerbatimRun(t, doc) >= VERBATIM_RUN_LIMIT) return;
      cases.push({ q: t.slice(0, 240), gold: f.id, source, heldOut: true });
    };
    for (const o of f.observations ?? []) add(o.note, 'observation');
    for (const p of f.predictions ?? []) add(p.reasoning, 'prediction');
  }
  return cases;
}

/**
 * The former held-out split, kept as an explicitly-labelled tripwire.
 *
 * These fields are indexed now, so a query drawn from one is text the
 * retriever has seen. It measures nothing about accuracy and is retained for
 * the same reason `evidence` was: a sharp drop here means something broke in
 * indexing, and that is worth catching even though a high score means nothing.
 */
export function inSampleCases(all: Finding[]): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const f of all) {
    if (f.status === 'retired') continue;
    if (f.mechanism && f.mechanism.length > 40)
      cases.push({ q: f.mechanism.slice(0, 240), gold: f.id, source: 'observation', heldOut: false });
    if (f.appliesTo && f.appliesTo.length > 30)
      cases.push({ q: f.appliesTo.slice(0, 240), gold: f.id, source: 'observation', heldOut: false });
  }
  return cases;
}
