/**
 * Use — what the retrieval ledger says about whether anyone has NEEDED a
 * finding, and the two things that is allowed to change: a label, and where
 * re-check effort goes. Never the score.
 *
 * THE OBJECTION THIS ANSWERS. Pure clock decay looks wrong from one angle: a
 * finding nobody retrieved in six months is not LESS TRUE for it; nobody was
 * working where it applies. "Untested because unneeded" reads, in the standing
 * machinery, exactly like "served nine times since and nobody confirmed it" —
 * both are `stale` — and those are different epistemic states.
 *
 * WHY THE CLOCK STAYS. `freshness()` in decay.ts is not a claim that the
 * finding became less true. It is the prior that the SUBJECT drifted — the MCP
 * server shipped, the CLI's default moved, the sandbox was rebuilt — and that
 * drift happens whether or not anyone was in the territory. Dormancy of the
 * observer is not stability of the subject. The knob for a subject that drifts
 * slowly already exists and is the author's to set: `halfLifeDays`, 7 to 3650.
 * And switching `confidence()` to use-driven would break four things at once:
 * twenty two-year-old confirmations would outrank one from last week
 * (corroboration would decide, since freshness stopped ticking); the stale
 * queue would only ever surface recently-used findings (urgency stopped moving
 * for everything else); a finding that quietly stopped being true would be
 * served at birth standing until the end of time (the clock was the only
 * thing lowering it without a person); and standing would stop being a pure
 * function of the file — the ledger is per machine and absent for a
 * federated finding, so a use-driven standing is unsignable and unauditable.
 *
 * SO: standing stays pure over the finding. This module reads the ledger and
 * produces (1) a RENDER-TIME label that splits `stale` into `dormant` (decayed,
 * and nobody has needed it since it was last confirmed) and `stale` proper
 * (decayed, served N times since, and nobody confirmed it — real doubt, with
 * the N a reader wants), and (2) a WEIGHT on decayUrgency, so re-verification
 * effort goes where use is — "no need to call it again until we build there"
 * is a statement about where to spend effort, not about what the finding is
 * worth. Neither touches decay.ts.
 */
import { readLedger, type RetrievalRecord } from './ledger';
import type { Finding } from './schema';
import { lastConfirmedAt, standing, decayUrgency, type Standing } from './decay';
import type { KeyRecord } from './signing';
import { loadKeys } from './keys';

export interface UseSignal {
  /** Retrievals that returned this finding since its last confirmation — or ever, if never confirmed. */
  sinceConfirmed: number;
  /** Retrievals that returned it in the last `windowDays`. */
  recent: number;
  /** When it was last returned to anyone, or null. */
  lastServedAt: string | null;
}

/** Recent-use window for the urgency weight. */
export const USE_WINDOW_DAYS = 90;

/*
 * The ledger is every author's shard read off disk. A gateway renders a
 * standing line per delivered finding, so it must not re-read the shards per
 * result; a minute is well within any latency the label could matter at.
 */
let cache: { at: number; rows: RetrievalRecord[] } | null = null;
const TTL_MS = 60_000;
export function cachedLedger(now = Date.now()): RetrievalRecord[] {
  if (cache && now - cache.at < TTL_MS) return cache.rows;
  let rows: RetrievalRecord[] = [];
  try {
    rows = readLedger();
  } catch {
    /* no ledger is no use: every finding reads dormant, which is the honest default */
  }
  cache = { at: now, rows };
  return rows;
}
/** Tests and writers that just appended: forget the cached read. */
export function forgetLedgerCache(): void {
  cache = null;
}

const served = (r: RetrievalRecord, id: string): boolean => Array.isArray(r.returned) && r.returned.some((x) => x.id === id);

export function usageSignal(f: Finding, ledger: RetrievalRecord[] = cachedLedger(), now = new Date(), windowDays = USE_WINDOW_DAYS): UseSignal {
  const since = lastConfirmedAt(f, now);
  const sinceMs = since ? new Date(since).getTime() : -Infinity;
  const windowMs = now.getTime() - windowDays * 86_400_000;
  let sinceConfirmed = 0;
  let recent = 0;
  let last: string | null = null;
  for (const r of ledger) {
    if (!served(r, f.id)) continue;
    const t = new Date(r.at).getTime();
    if (!Number.isFinite(t) || t > now.getTime()) continue;
    if (t > sinceMs) sinceConfirmed++;
    if (t >= windowMs) recent++;
    if (!last || t > new Date(last).getTime()) last = r.at;
  }
  return { sinceConfirmed, recent, lastServedAt: last };
}

/**
 * Standing, with `stale` split by use. Every other standing passes through
 * untouched: `contested` is somebody's signed disagreement, `fresh`/`aging`
 * are the clock doing its job, and `retired` is a person's decision.
 */
export type UseLabel = Standing | 'dormant';
export function usageLabel(f: Finding, use: UseSignal, now = new Date(), keys: Map<string, KeyRecord> = loadKeys()): UseLabel {
  const s = standing(f, now, keys);
  return s === 'stale' && use.sinceConfirmed === 0 ? 'dormant' : s;
}

/**
 * How much a finding's re-check effort is scaled by recent use: 0.5 for a
 * finding nobody has retrieved (still worth some effort — a wrong dormant
 * finding is still wrong), rising to 2.0 as retrievals accumulate. Saturating
 * for the same reason corroboration does: the tenth retrieval says less than
 * the second.
 */
export function usageWeight(recent: number): number {
  return 0.5 + 1.5 * (1 - Math.pow(0.5, Math.max(0, recent)));
}

/** decayUrgency (pure, in decay.ts) times the use weight. Where re-check effort should go. */
export function usageWeightedUrgency(f: Finding, ledger: RetrievalRecord[] = cachedLedger(), now = new Date()): number {
  return decayUrgency(f, now) * usageWeight(usageSignal(f, ledger, now).recent);
}
