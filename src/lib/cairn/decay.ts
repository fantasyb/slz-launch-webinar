import { environmentSignature, type Finding, type Observation } from './schema';
import { verifyObservation, findingBodyHash } from './signing';
import { loadKeys } from './keys';

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
  const t = new Date(iso).getTime();
  // A malformed date produced NaN, which propagated to confidence and was
  // silently classified `stale` — both thresholds are false against NaN.
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  // A future timestamp pinned freshness at 1.0 permanently, and a future-dated
  // refutation made `latestRefutation` unreachable by any honest confirmation,
  // freezing `contested` forever. Lint rejects future dates in cairn/*.json but
  // federated bundles never pass through lint, so the clamp belongs here where
  // every path reaches it: treat anything ahead of now as exactly now, so it
  // buys no advantage over an honest observation made this instant.
  return Math.max(0, (now.getTime() - t) / DAY_MS);
}

/** Most recent observation of any verdict. */
export function latestObservation(f: Finding): Observation {
  return [...f.observations].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  )[0];
}

/** Distinct observers who confirmed. Repeat checks by one agent count once. */
export function confirmationCount(f: Finding, now: Date = new Date()): number {
  const confirmers = new Set(
    f.observations
      .filter((o) => o.verdict === 'confirmed' && notInFuture(o, now))
      .map(partyOf)
      .filter((p): p is string => p !== null),
  );
  return confirmers.size;
}

/**
 * An observation cannot describe a check that has not run yet.
 *
 * Clamping a future date to "now" was not enough: the clamp re-applies on
 * every evaluation, so a single observation dated 2099 held freshness at 1.0
 * permanently — the decay this corpus depends on simply never started. A date
 * ahead of the clock is not evidence about the past, so it contributes
 * nothing rather than everything.
 */
function notInFuture(o: Finding['observations'][number], now: Date): boolean {
  const t = new Date(o.at).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

export function lastConfirmedAt(f: Finding, now: Date = new Date()): string | null {
  const confirmed = f.observations
    .filter((o) => o.verdict === 'confirmed' && notInFuture(o, now))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return confirmed[0]?.at ?? null;
}

/** 1.0 at the moment of confirmation, 0.5 after one half-life. */
export function freshness(f: Finding, now: Date = new Date()): number {
  const at = lastConfirmedAt(f, now);
  if (!at) return 0;
  return Math.pow(0.5, daysSince(at, now) / f.halfLifeDays);
}

/** 1 observer -> 0.50, 2 -> 0.75, 3 -> 0.875. Saturating, never reaching 1. */
export function corroboration(f: Finding): number {
  const n = confirmationCount(f);
  return n === 0 ? 0 : 1 - Math.pow(0.5, n);
}

/**
 * Distinct environments in which the finding was confirmed.
 *
 * Corroboration counts observers, which guards against one agent asserting
 * a thing repeatedly. It does not guard against a hundred agents running in
 * identical containers, which is the likely shape of a large agent corpus
 * and is barely more informative than one. Breadth is the signal that
 * separates 'broken' from 'broken here'.
 */
export function environmentCount(f: Finding): number {
  return new Set(
    f.observations
      .filter((o) => o.verdict === 'confirmed' && o.environment)
      .map((o) => environmentSignature(o.environment!)),
  ).size;
}

/**
 * Distinct environments backed by a verifying signature.
 *
 * Breadth is what earns `universal` scope, which makes fabricating
 * confirmations from invented agents in invented environments the cheapest
 * way to promote a false claim. An unsigned environment is attributable to
 * nobody, so it buys half the breadth of a signed one — enough that honest
 * unsigned reports still count, not enough to make forgery worthwhile.
 */
export function signedEnvironmentCount(f: Finding): number {
  const keys = loadKeys();
  const attested = f.observations.filter(
    (o) =>
      o.verdict === 'confirmed' &&
      o.environment &&
      verifyObservation(f.id, o, keys, findingBodyHash(f)) === 'signed',
  );

  const environments = new Set(attested.map((o) => environmentSignature(o.environment!)));
  const signers = new Set(attested.map((o) => o.signature!.keyId));

  // Breadth is capped by the number of distinct signers.
  //
  // Signing proves who made a claim, never that the claim is true — an agent
  // can sign "os: darwin" from Linux, and this file says so elsewhere. So
  // counting environments alone let a single key manufacture universality by
  // asserting five machines it never ran on, which is the cheapest possible
  // attack on the one mechanism that is supposed to make universal scope
  // expensive.
  //
  // One party reporting five environments is not five independent
  // confirmations; it is one party's word about five places. Capping breadth
  // at the number of distinct signers makes that exactly as valuable as it
  // should be, without needing to detect the lie.
  return Math.min(environments.size, signers.size);
}

/** Signed environments count fully; unsigned ones at half weight. */
export function effectiveEnvironments(f: Finding): number {
  const signed = signedEnvironmentCount(f);
  const unsigned = Math.max(0, environmentCount(f) - signed);
  return signed + 0.5 * unsigned;
}

/**
 * How much the evidence supports the scope being claimed.
 *
 * A universal claim confirmed in one environment has not earned the word
 * 'universal', so it is discounted until breadth arrives: 0 environments
 * 0.45, then 0.65, 0.83, 0.91, approaching 1. An environment-specific claim
 * only ever asserted its own environment, so breadth is not owed — it needs
 * one execution somewhere, and is discounted only if it has none.
 */
export function scopeSupport(f: Finding): number {
  // A structural claim follows from how the thing is built, so there is no
  // second environment that could corroborate it. Discounting it for breadth
  // would penalise it permanently for being the wrong kind of claim. It is
  // held to a different bar instead: a derivation, enforced at lint.
  if (f.basis === 'structural') return 1;

  const n = effectiveEnvironments(f);
  if (f.scope === 'environment-specific') return n === 0 ? 0.6 : Math.min(1, 0.8 + 0.2 * n);
  if (n === 0) return 0.45;
  return 1 - 0.35 * Math.pow(0.5, n - 1);
}

/**
 * Combined score in [0, 1]. Freshness dominates: a single fresh confirmation
 * (0.75) outranks three stale ones, which is the intended bias.
 */
export function confidence(f: Finding, now: Date = new Date()): number {
  if (f.status === 'retired') return 0;
  if (latestObservation(f).verdict === 'refuted') return 0;
  return freshness(f, now) * (0.5 + 0.5 * corroboration(f)) * scopeSupport(f);
}

export type Standing = 'fresh' | 'aging' | 'stale' | 'contested' | 'retired';

/**
 * Distinct signers who confirmed, and who refuted.
 *
 * Counted by signer rather than by observation, because the question a reader
 * is asking — "do people who tried this disagree?" — is about parties, not
 * about how many times one party spoke.
 */
/**
 * One identifier namespace for a party.
 *
 * Mixing a signed observation's keyId with an unsigned one's free-text label
 * meant the same party counted as two: alice signs one confirmation and adds
 * one unsigned, and the two-to-one rule clears her own refutation. Resolving a
 * key to its published label puts both on the same footing, and an unsigned
 * observation is identified only by a string anyone may claim — which is why
 * it is worth less below.
 */
function partyOf(o: Finding['observations'][number]): string | null {
  // An unsigned observation is attributable to nobody: `by` is a free string
  // anyone may claim, so it cannot establish that a distinct party spoke.
  // Namespacing signed and unsigned separately was not enough — one party
  // signing once and adding one unsigned line still counted as two, which is
  // the two-line rescue this rule exists to prevent.
  //
  // The exclusion is symmetric on purpose. If unsigned refutations counted,
  // anyone could contest any true finding for free, which is the same defect
  // pointed the other way. Unsigned observations are still recorded, still
  // displayed, and still count toward freshness; they just cannot move a
  // disagreement, because moving one is a claim about who you are.
  return o.signature ? `key:${o.signature.keyId}` : null;
}

function distinctParties(observations: Finding['observations']): number {
  return new Set(observations.map(partyOf).filter((p): p is string => p !== null)).size;
}

export function disagreement(f: Finding): { confirmers: number; refuters: number } {
  const refutations = f.observations.filter((o) => o.verdict === 'refuted');
  const refuters = new Set(
    refutations.map(partyOf).filter((p): p is string => p !== null),
  );
  if (refuters.size === 0) {
    return {
      confirmers: new Set(
        f.observations.filter((o) => o.verdict === 'confirmed').map(partyOf)
          .filter((p): p is string => p !== null),
      ).size,
      refuters: 0,
    };
  }

  // Only confirmations made AFTER the most recent refutation can answer it.
  //
  // Counting every confirmation let the finding's own originating observation
  // help clear a later refutation, so a single added line was enough — the
  // originator confirmed at creation, and one attacker made two. A refutation
  // says "this did not reproduce for me", and the only thing that speaks to
  // that is someone re-running the check afterwards.
  // Clamped for the same reason: a refutation dated in the future would sit
  // beyond every possible confirmation and could never be answered.
  const nowMs = Date.now();
  const latestRefutation = Math.max(
    ...refutations.map((o) => Math.min(new Date(o.at).getTime() || 0, nowMs)),
  );
  const confirmers = new Set(
    f.observations
      .filter((o) => o.verdict === 'confirmed' && new Date(o.at).getTime() > latestRefutation)
      .map(partyOf)
      .filter((p): p is string => p !== null),
  );
  return { confirmers: confirmers.size, refuters: refuters.size };
}

export function standing(f: Finding, now: Date = new Date()): Standing {
  if (f.status === 'retired') return 'retired';

  // A refutation is not erased by whoever speaks next.
  //
  // Reading only the latest observation meant one appended "works for me",
  // from any key at all, laundered a refuted finding back to a usable
  // standing — which inverts the mechanism, since the cheapest way to rescue
  // a disproven claim became adding a single line to it.
  //
  // A refutation now stands until confirmations from distinct signers
  // outnumber refuters two to one. Honest disagreement clears in the ordinary
  // course of people re-running a check; one party cannot clear it alone at
  // any volume.
  const { confirmers, refuters } = disagreement(f);
  if (refuters > 0 && confirmers < 2 * refuters) return 'contested';
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

  // A contested finding is the single most informative thing to re-check, and
  // it used to rank last. confidence() floors a refuted finding to 0, so
  // `1 - |0 - 0.5| * 2` was 0 and every factor after it — including the 1.5
  // contested boost — multiplied into nothing. The boost could never fire,
  // because the only state that set it also zeroed everything it multiplied.
  const contestedNow = standing(f, now) === 'contested';
  const c = contestedNow ? freshness(f, now) * 0.5 : confidence(f, now);
  const uncertainty = contestedNow ? 1 : 1 - Math.abs(c - 0.5) * 2;
  const stakes = { minutes: 0.4, hours: 0.8, days: 1 }[f.cost];
  const effort = f.check.manual ? 0.35 : 1;
  const contested = contestedNow ? 1.5 : 1;
  // A universal claim standing on one environment is the cheapest place to
  // buy real information: a second environment either earns the scope or
  // exposes it as local.
  // Only empirical claims gain from another environment.
  const unearned =
    f.basis === 'empirical' && f.scope === 'universal' && effectiveEnvironments(f) < 2 ? 1.4 : 1;
  return uncertainty * stakes * effort * contested * unearned;
}

export function formatConfidence(c: number): string {
  return `${Math.round(c * 100)}%`;
}

/**
 * What the corpus itself says happened, as of a moment in time.
 *
 * This is the ground truth a forecast is scored against, and it must not come
 * from the party being scored. Accepting it on the command line meant a
 * predictor could seal 0.9, watch the check refute, and reveal "confirmed" —
 * the seal proved the prior was unedited while the answer key was typed in by
 * hand. Reading the newest observation instead was the same defect wearing
 * different clothes: one appended line retroactively redefined the outcome of
 * every forecast on that finding at once.
 *
 * It uses the same distinct-signer arithmetic as `standing`, so a finding that
 * reads `contested` to a human resolves as `refuted` to the scorer rather than
 * silently counting as a hit.
 *
 * The window matters in both directions, and getting only one end right is
 * what made this function unsound for as long as it existed.
 *
 * `asOf` closes the late end: a resolution is a statement about the evidence
 * that existed when it was made, and observations added afterwards must not
 * retroactively make an honest resolution look wrong.
 *
 * `since` closes the early end, and it is the load-bearing one. A forecast is
 * a claim about what a check *will* show; evidence that already existed when
 * the forecast was sealed cannot resolve it. Without this bound, `predict`
 * followed immediately by `reveal` — with no check ever run — resolved against
 * the finding's own founding observation and printed a Brier score. The seal
 * was cryptographically perfect and the number underneath it was invented.
 * Callers must pass the seal time; there is deliberately no default, because
 * every omission of it was a fabricated score.
 */
export function derivedVerdict(
  f: Finding,
  window: { since: Date; asOf?: Date },
): 'confirmed' | 'refuted' | 'inconclusive' {
  const asOf = window.asOf ?? new Date();
  const lo = window.since.getTime();
  const hi = asOf.getTime();
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 'inconclusive';
  const visible: Finding = {
    ...f,
    observations: f.observations.filter((o) => {
      const t = new Date(o.at).getTime();
      return Number.isFinite(t) && t > lo && t <= hi;
    }),
  };
  if (visible.observations.length === 0) return 'inconclusive';

  const { confirmers, refuters } = disagreement(visible);
  if (refuters > 0 && confirmers < 2 * refuters) return 'refuted';
  if (confirmers > 0) return 'confirmed';
  return 'inconclusive';
}
