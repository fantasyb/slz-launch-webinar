import type { Finding, Observation } from './schema';

export const DAY_MS = 86_400_000;

/**
 * Confidence has two independent inputs, and it matters that they are
 * independent:
 *
 *   freshness     — how long since anyone last checked. Decays by half
 *                   every `halfLifeDays`. Nothing stops this but re-testing.
 *   corroboration — how many separate observers confirmed it. Saturating,
 *                   because the tenth confirmation tells you far less than
 *                   the second.
 *
 * A finding confirmed by twenty agents two years ago is not trustworthy,
 * and a corpus whose scoring cannot say so is worse than no corpus.
 */

export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / DAY_MS);
}

/** Most recent observation of any verdict. */
export function latestObservation(f: Finding): Observation {
  return [...f.observations].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  )[0];
}

/** Distinct observers who confirmed. Repeat checks by one agent count once. */
export function confirmationCount(f: Finding): number {
  const confirmers = new Set(
    f.observations.filter((o) => o.verdict === 'confirmed').map((o) => o.by),
  );
  return confirmers.size;
}

export function lastConfirmedAt(f: Finding): string | null {
  const confirmed = f.observations
    .filter((o) => o.verdict === 'confirmed')
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return confirmed[0]?.at ?? null;
}

/** 1.0 at the moment of confirmation, 0.5 after one half-life. */
export function freshness(f: Finding, now: Date = new Date()): number {
  const at = lastConfirmedAt(f);
  if (!at) return 0;
  return Math.pow(0.5, daysSince(at, now) / f.halfLifeDays);
}

/** 1 observer -> 0.50, 2 -> 0.75, 3 -> 0.875. Saturating, never reaching 1. */
export function corroboration(f: Finding): number {
  const n = confirmationCount(f);
  return n === 0 ? 0 : 1 - Math.pow(0.5, n);
}

/**
 * Combined score in [0, 1]. Freshness dominates: a single fresh confirmation
 * (0.75) outranks three stale ones, which is the intended bias.
 */
export function confidence(f: Finding, now: Date = new Date()): number {
  if (f.status === 'retired') return 0;
  if (latestObservation(f).verdict === 'refuted') return 0;
  return freshness(f, now) * (0.5 + 0.5 * corroboration(f));
}

export type Standing = 'fresh' | 'aging' | 'stale' | 'contested' | 'retired';

export function standing(f: Finding, now: Date = new Date()): Standing {
  if (f.status === 'retired') return 'retired';
  if (latestObservation(f).verdict === 'refuted') return 'contested';
  const c = confidence(f, now);
  if (c >= 0.7) return 'fresh';
  if (c >= 0.3) return 'aging';
  return 'stale';
}

/**
 * Which finding most deserves an agent's spare cycles.
 *
 * Re-checking is only worth doing where the answer would change something.
 * That means: expensive to rediscover, cheap to re-test, and currently
 * uncertain. Findings near confidence 0.5 are the most informative to probe;
 * one at 0.95 or 0.05 tells you little you did not already know.
 */
export function decayUrgency(f: Finding, now: Date = new Date()): number {
  if (f.status === 'retired') return 0;
  const c = confidence(f, now);
  const uncertainty = 1 - Math.abs(c - 0.5) * 2;
  const stakes = { minutes: 0.4, hours: 0.8, days: 1 }[f.cost];
  const effort = f.check.manual ? 0.35 : 1;
  const contested = latestObservation(f).verdict === 'refuted' ? 1.5 : 1;
  return uncertainty * stakes * effort * contested;
}

export function formatConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}
