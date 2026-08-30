import type { Finding, Prediction } from './schema';
import { commitmentStatus, type CommitmentStatus } from './commitment';
import { findingBodyHash } from './signing';
import { loadKeys } from './keys';

/**
 * Scoring for the prediction ledger.
 *
 * Two quantities matter, and they measure opposite things:
 *
 *   brier      — how wrong a predictor was. A property of the model.
 *   surprise   — how wrong predictors collectively were. A property of the
 *                finding, and the reason this corpus is worth more than the
 *                sum of its facts: it identifies which claims are NOT already
 *                in the weights.
 *
 * A finding everyone predicts correctly is already known and teaches nothing.
 * A finding confident predictors get wrong is, by definition, knowledge the
 * models do not have. Ranking by surprise ranks by information gain.
 */

export type Resolved = Prediction & {
  outcome: NonNullable<Prediction['outcome']>;
  priorConfirmed: number;
  reasoning: string;
};

export function statusOf(findingId: string, p: Prediction): CommitmentStatus {
  return commitmentStatus(findingId, p);
}

/**
 * Whether a prediction was made by the finding's own originator.
 *
 * `self` is a self-declared flag, and a predictor who knows the answer has
 * every reason to leave it false. So it is derived instead: the originator is
 * whoever signed the earliest observation — the party who put the finding into
 * the corpus and therefore knew its outcome before anyone could forecast it.
 *
 * The declared flag is still honoured, but only in the direction that adds
 * exclusion. Someone may mark their own prediction self-authored for reasons
 * the code cannot see; nobody may mark it away.
 */
export function isSelfPrediction(f: Finding, p: Prediction): boolean {
  if (p.self) return true;
  const earliest = [...f.observations].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  )[0];
  if (!earliest) return false;

  // The originator is whoever SIGNED the earliest observation, resolved
  // through the key record, falling back to the free-text `by` only when the
  // observation is unsigned. Comparing `by` on both sides unconditionally made
  // the rule depend on a string the author picks: predicting under a slightly
  // different label evaded the exclusion, and creating a finding whose
  // unsigned founding observation carries a rival's label excluded that
  // rival's forecasts on it.
  //
  // This is a mitigation, not a fix. Predictions carry no key, so the
  // prediction side of the comparison is still free text and still trusted.
  // The honest statement of the guarantee: a SIGNED founding observation
  // cannot have its identity chosen by a later contributor; the forecaster's
  // own label can. Binding predictions to keys is what would close it.
  const keys = loadKeys();
  const originator =
    (earliest.signature && keys.get(earliest.signature.keyId)?.label) || earliest.by;
  return originator === p.by;
}

/**
 * A prediction counts toward calibration only if all four hold:
 *
 *   1. it resolved to confirmed or refuted (inconclusive has no truth value);
 *   2. it was revealed, so a prior and reasoning exist;
 *   3. its commitment recomputes, proving it was sealed before the check and
 *      not edited afterwards;
 *   4. it is not a self-prediction by the finding's own author.
 *
 * Everything else is displayed and excluded. Scoring unanchored self-reports
 * would make the headline number meaningless, which is precisely the failure
 * this corpus was built to avoid reproducing.
 */
export function isScorable(findingId: string, p: Prediction): p is Resolved {
  if (p.outcome !== 'confirmed' && p.outcome !== 'refuted') return false;
  if (p.priorConfirmed === undefined || p.reasoning === undefined) return false;
  return statusOf(findingId, p) === 'verified';
}

/** As isScorable, but with the originator check that needs the whole finding. */
export function isScorableIn(f: Finding, p: Prediction): p is Resolved {
  // A forecast about a claim that has since been rewritten is not a forecast
  // about this finding, and scoring it against this finding's evidence would
  // credit or penalise a prediction for text it never saw.
  //
  // A forecast with no bodyHash at all is the same problem with the evidence
  // missing: nothing binds it to any particular wording, so it cannot be shown
  // to be about the claim it is being scored against. It is excluded for the
  // same reason, and this must stay in step with lint-corpus.ts, which reports
  // exactly these predictions as unscored — the two disagreed once, and the
  // corpus told a reader the opposite of what the scorer did.
  if (!p.bodyHash || p.bodyHash !== findingBodyHash(f)) return false;
  // No resolvedAt means no moment to check the outcome against, and lint's
  // cross-check is gated on the same field. Scoring it would trust the
  // forecaster's own record of the answer.
  if (!p.resolvedAt) return false;
  return isScorable(f.id, p) && !isSelfPrediction(f, p);
}

export function actualValue(p: Resolved): 0 | 1 {
  return p.outcome === 'confirmed' ? 1 : 0;
}

/** Squared error. 0 is perfect; 1 is confidently wrong; 0.25 is a coin flip. */
export function brier(p: Resolved): number {
  return Math.pow(p.priorConfirmed - actualValue(p), 2);
}

export function scorablePredictions(findings: Finding[]): Array<Resolved & { findingId: string }> {
  return findings.flatMap((f) =>
    f.predictions.filter((p) => isScorableIn(f, p)).map((p) => ({ ...p, findingId: f.id })),
  );
}

/** Every prediction with its commitment status, for display and auditing. */
export function allPredictions(findings: Finding[]) {
  return findings.flatMap((f) =>
    f.predictions.map((p) => ({
      ...p,
      findingId: f.id,
      status: statusOf(f.id, p),
      scorable: isScorableIn(f, p),
      self: isSelfPrediction(f, p),
    })),
  );
}

export interface LedgerIntegrity {
  total: number;
  verified: number;
  sealed: number;
  broken: number;
  unanchored: number;
  /** Sealed under the v1 encoding, which did not bind the field values. */
  legacyEncoding: number;
  self: number;
  scored: number;
}

export function ledgerIntegrity(findings: Finding[]): LedgerIntegrity {
  const all = allPredictions(findings);
  return {
    total: all.length,
    verified: all.filter((p) => p.status === 'verified').length,
    sealed: all.filter((p) => p.status === 'sealed').length,
    broken: all.filter((p) => p.status === 'broken').length,
    unanchored: all.filter((p) => p.status === 'unanchored').length,
    legacyEncoding: all.filter((p) => p.status === 'legacy-encoding').length,
    self: all.filter((p) => p.self).length,
    scored: all.filter((p) => p.scorable).length,
  };
}

/**
 * Mean absolute prediction error across everyone who forecast this finding.
 * High means confident predictors were wrong: the finding carries information
 * the model population lacks.
 */
export function surprise(f: Finding): number | null {
  const scored = f.predictions.filter((p) => isScorableIn(f, p));
  if (scored.length === 0) return null;
  return (
    scored.reduce((acc, p) => acc + Math.abs(p.priorConfirmed - actualValue(p)), 0) /
    scored.length
  );
}

export interface ModelScore {
  by: string;
  n: number;
  /** null when this predictor has revealed nothing — never 0, which reads as perfect. */
  brier: number | null;
  /** Mean stated confidence, after orienting each prediction toward its own claim. */
  meanConfidence: number | null;
  accuracy: number | null;
  /**
   * Forecasts this predictor sealed and never revealed.
   *
   * Commit-reveal stops a forecast being edited after the fact. It does not
   * stop a predictor sealing ten and revealing only the five they got right,
   * which inflates a Brier score arbitrarily while every published number
   * remains individually honest. Selective revelation is the attack the seal
   * does not cover, and it is aimed squarely at the metric this corpus exists
   * to produce.
   *
   * It cannot be prevented — a predictor may always decline to reveal — so it
   * is made visible instead. An abandoned seal is a permanent public record
   * that a forecast was made and withheld.
   */
  abandoned: number;
  /**
   * Brier recomputed as if every abandoned seal had been maximally wrong.
   *
   * The honest bound on a predictor who withholds: their true score lies
   * between `brier` and this. A predictor with no abandoned seals has one
   * number; a predictor with many has a range, and the width of that range is
   * the cost of withholding.
   */
  brierWorstCase: number;
}

export function scoreByModel(findings: Finding[]): ModelScore[] {
  const groups = new Map<string, Resolved[]>();
  for (const p of scorablePredictions(findings)) {
    const list = groups.get(p.by) ?? [];
    list.push(p);
    groups.set(p.by, list);
  }
  // Seals this predictor published and never revealed, counted from the whole
  // corpus rather than from the scorable set — that is the point.
  // A seal is abandoned only once the finding it forecasts has been settled.
  // Counting every unrevealed seal punished the honest protocol: sealing is
  // step one, so a predictor following the instructions had their worst-case
  // score jump toward 1 and their rank drop until they revealed.
  // "Settled" has to be measured per prediction, against evidence recorded
  // AFTER that prediction's seal.
  //
  // Checking whether the finding had any decisive observation was vacuous:
  // the schema requires at least one and the protocol confirms at creation,
  // so every finding is settled at birth. A seal therefore counted as
  // abandoned from the moment it was made — the predictor had not yet had
  // time to run the check — which is precisely the punished-honest-protocol
  // failure this set was added to prevent. A predictor with the best Brier in
  // the corpus dropped below a strictly worse one by following step one of
  // the instructions.
  const abandonedBy = new Map<string, number>();
  for (const f of findings) {
    for (const p of f.predictions) {
      if (!p.commitment || p.priorConfirmed !== undefined) continue;
      const sealedAt = new Date(p.at).getTime();
      const settledAfterSeal = f.observations.some((o) => {
        const t = new Date(o.at).getTime();
        return Number.isFinite(t) && t > sealedAt && o.verdict !== 'inconclusive';
      });
      if (!settledAfterSeal) continue;
      abandonedBy.set(p.by, (abandonedBy.get(p.by) ?? 0) + 1);
    }
  }
  // A predictor whose forecasts are ALL abandoned had no row at all, so the
  // worst offender was the one the report could not see.
  for (const by of abandonedBy.keys()) if (!groups.has(by)) groups.set(by, []);

  return [...groups.entries()]
    .map(([by, ps]) => {
      const abandoned = abandonedBy.get(by) ?? 0;
      const sum = ps.reduce((a, p) => a + brier(p), 0);
      return {
        by,
        n: ps.length,
        brier: ps.length ? sum / ps.length : null,
        // How confident they were in whichever direction they leaned.
        meanConfidence: ps.length
          ? ps.reduce((a, p) => a + Math.max(p.priorConfirmed, 1 - p.priorConfirmed), 0) / ps.length
          : null,
        accuracy: ps.length
          ? ps.filter((p) => (p.priorConfirmed >= 0.5 ? 1 : 0) === actualValue(p)).length / ps.length
          : null,
        abandoned,
        // Each withheld forecast counted as maximally wrong (squared error 1).
        brierWorstCase: (sum + abandoned) / (ps.length + abandoned),
      };
    })
    // Rank by the worst case, so withholding cannot buy a better position.
    .sort((a, b) => a.brierWorstCase - b.brierWorstCase);
}

/**
 * The baseline that makes a Brier score legible: always predicting 0.5 scores
 * 0.25. Anything above that is worse than declining to guess.
 */
export const UNINFORMED_BRIER = 0.25;

export interface CalibrationBin {
  lower: number;
  upper: number;
  n: number;
  /** null when the bin is empty — never 0, which plots as perfect calibration. */
  predicted: number | null;
  actual: number | null;
}

/** Standard reliability bins: within each, stated confidence vs observed rate. */
export function calibrationCurve(findings: Finding[], bins = 5): CalibrationBin[] {
  const ps = scorablePredictions(findings);
  return Array.from({ length: bins }, (_, i) => {
    // i / bins, not i * (1 / bins): 3 * (1/5) is 0.6000000000000001, so a
    // stated 0.6 failed `>= lower` and was charged to the bin below.
    const lower = i / bins;
    const upper = (i + 1) / bins;
    const inBin = ps.filter(
      (p) => p.priorConfirmed >= lower && (i === bins - 1 ? p.priorConfirmed <= upper : p.priorConfirmed < upper),
    );
    return {
      lower,
      upper,
      n: inBin.length,
      // null at n=0, not 0. Three empty bins reporting {predicted: 0,
      // actual: 0} render as three perfectly-calibrated points at the origin
      // for any plot that does not check `n`. corpusCalibration got this
      // right; the curve it sits beside did not.
      predicted: inBin.length
        ? inBin.reduce((a, p) => a + p.priorConfirmed, 0) / inBin.length
        : null,
      actual: inBin.length ? inBin.reduce((a, p) => a + actualValue(p), 0) / inBin.length : null,
    };
  });
}

export interface CorpusCalibration {
  n: number;
  /** All null when n is 0 — never 0, which is the best achievable score. */
  brier: number | null;
  accuracy: number | null;
  meanConfidence: number | null;
  /** Positive means better than refusing to guess; negative means worse. */
  edgeOverUninformed: number | null;
  /** All scored predictions are sealed by construction; kept for the API shape. */
  sealedShare: number | null;
}

export function corpusCalibration(findings: Finding[]): CorpusCalibration {
  const ps = scorablePredictions(findings);
  if (ps.length === 0) {
    // null, not 0: zero is the best possible Brier, so an empty corpus
    // rendered as perfectly calibrated to any consumer not checking n.
    return {
      n: 0, brier: null, accuracy: null, meanConfidence: null,
      edgeOverUninformed: null, sealedShare: null,
    };
  }
  const b = ps.reduce((a, p) => a + brier(p), 0) / ps.length;
  return {
    n: ps.length,
    brier: b,
    accuracy:
      ps.filter((p) => (p.priorConfirmed >= 0.5 ? 1 : 0) === actualValue(p)).length / ps.length,
    meanConfidence:
      ps.reduce((a, p) => a + Math.max(p.priorConfirmed, 1 - p.priorConfirmed), 0) / ps.length,
    edgeOverUninformed: UNINFORMED_BRIER - b,
    sealedShare: ps.filter((p) => !!p.commitment).length / ps.length,
  };
}

/**
 * Calibration split by basis.
 *
 * A model that forecasts an empirical claim wrongly lacked knowledge of how
 * some system behaves. A model that forecasts a structural claim wrongly
 * failed to reason from what it already had — the property follows from the
 * design, so the information was in principle available to it.
 *
 * Those are different failures with different remedies, and a single Brier
 * score over both measures neither. Reported separately, they are two useful
 * numbers instead of one misleading average.
 */
export interface BasisCalibration {
  empirical: CorpusCalibration;
  structural: CorpusCalibration;
}

export function calibrationByBasis(findings: Finding[]): BasisCalibration {
  const of = (basis: 'empirical' | 'structural') =>
    corpusCalibration(findings.filter((f) => (f.basis ?? 'empirical') === basis));
  return { empirical: of('empirical'), structural: of('structural') };
}
