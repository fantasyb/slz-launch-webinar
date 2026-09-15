/**
 * Memory — what this corpus has learned from its own delivery.
 *
 * The ledger records what was served and, where anything graded it, what
 * became of it. This turns that history into signals a retrieval can use.
 *
 * WHAT MEMORY IS FOR HERE
 *
 * Not personalisation. The useful memory for a corpus is not who the reader is,
 * it is WHAT THIS CORPUS HAS ALREADY GOT WRONG. A finding surfaced first,
 * confidently, on a query whose reader then failed anyway is a finding that
 * looked relevant and was not, and nothing else in this system can see that:
 * the ranking cannot, because it produced the mistake, and the checks cannot,
 * because they verify whether a claim is TRUE and this is about whether it was
 * RELEVANT. Those are different failures and only one of them has ever been
 * measured here.
 *
 * DELIBERATELY WEAK, AND SLOW TO BELIEVE ANYTHING
 *
 * Outcome data is sparse and always will be: most retrievals are served to
 * somebody who never reports back, and a design that only works when outcomes
 * are dense is a design that never works. So every signal here is evidence to
 * be weighed, never a rule, requires a minimum number of observations before it
 * says anything at all, and is symmetric — it can lift a finding that keeps
 * helping as readily as it damps one that keeps misleading.
 *
 * The failure mode being guarded against is a feedback loop: a finding ranked
 * down for one early mistake is served less, so it gathers no evidence to
 * recover on, and the ranking has quietly become permanent. Hence the floor on
 * observations, the cap on how far any of this can move a score, and the fact
 * that `missed` — the finding that SHOULD have been first and was not — counts
 * in the finding's favour.
 */
import type { Outcome, RetrievalRecord } from './ledger';

export interface Reputation {
  /** Times this finding was returned at all. */
  served: number;
  /** Times it was returned first. */
  surfaced: number;
  /** Times the reader went on to succeed after it led. */
  helped: number;
  /** Times it led confidently and the reader failed anyway. */
  misled: number;
  /** Times it was the right answer and did not lead. */
  missed: number;
  /**
   * Evidence-weighted opinion, -1 to +1, or null when there is not enough to
   * have one. Null is the common and correct case.
   */
  standing: number | null;
}

/** Below this many graded outcomes, a finding has no reputation at all. */
export const MIN_OUTCOMES = 3;

/**
 * How far reputation may move a score, as a multiplier either side of 1.
 * Small on purpose: this is one signal among five rankers, and the cost of
 * being wrong is a finding that stops being seen and can never recover.
 */
export const MEMORY_SPAN = 0.15;

export function reputations(ledger: RetrievalRecord[]): Map<string, Reputation> {
  const out = new Map<string, Reputation>();
  const bump = (id: string, k: keyof Omit<Reputation, 'standing'>) => {
    let r = out.get(id);
    if (!r) {
      r = { served: 0, surfaced: 0, helped: 0, misled: 0, missed: 0, standing: null };
      out.set(id, r);
    }
    r[k] += 1;
  };
  for (const rec of ledger) {
    for (const [id, o] of Object.entries(rec.outcomes ?? {})) {
      bump(id, 'served');
      if (o === 'surfaced') bump(id, 'surfaced');
      if (o === 'helped') { bump(id, 'surfaced'); bump(id, 'helped'); }
      if (o === 'misled') { bump(id, 'surfaced'); bump(id, 'misled'); }
      if (o === 'missed') bump(id, 'missed');
    }
  }
  for (const r of out.values()) {
    /*
     * `missed` counts FOR the finding, which reads oddly until you ask what it
     * records: the right answer, present, not ranked first. That is the ranking
     * failing the finding rather than the finding failing the reader, and
     * counting it against would punish a record for being hard to retrieve —
     * making it harder to retrieve.
     */
    const good = r.helped + r.missed;
    const graded = good + r.misled;
    r.standing = graded >= MIN_OUTCOMES ? (good - r.misled) / graded : null;
  }
  return out;
}

/**
 * Multiplier for a finding's score. 1 when memory has no opinion, which is
 * most of the time and the reason this can be switched on safely.
 */
export function memoryWeight(rep: Reputation | undefined): number {
  if (!rep || rep.standing === null) return 1;
  return 1 + MEMORY_SPAN * rep.standing;
}
