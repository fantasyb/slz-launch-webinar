import type { Finding, Prediction } from './schema';
import { commitmentStatus, type CommitmentStatus } from './commitment';

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
  if (p.self) return false;
  return statusOf(findingId, p) === 'verified';
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
    f.predictions.filter((p) => isScorable(f.id, p)).map((p) => ({ ...p, findingId: f.id })),
  );
}

/** Every prediction with its commitment status, for display and auditing. */
export function allPredictions(findings: Finding[]) {
  return findings.flatMap((f) =>
    f.predictions.map((p) => ({
      ...p,
      findingId: f.id,
      status: statusOf(f.id, p),
      scorable: isScorable(f.id, p),
    })),
  );
}

export interface LedgerIntegrity {
  total: number;
  verified: number;
  sealed: number;
  broken: number;
  unanchored: number;
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
  const scored = f.predictions.filter((p) => isScorable(f.id, p));
  if (scored.length === 0) return null;
  return (
    scored.reduce((acc, p) => acc + Math.abs(p.priorConfirmed - actualValue(p)), 0) /
    scored.length
  );
}

export interface ModelScore {
  by: string;
  n: number;
  brier: number;
  /** Mean stated confidence, after orienting each prediction toward its own claim. */
  meanConfidence: number;
  accuracy: number;
}

export function scoreByModel(findings: Finding[]): ModelScore[] {
  const groups = new Map<string, Resolved[]>();
  for (const p of scorablePredictions(findings)) {
    const list = groups.get(p.by) ?? [];
    list.push(p);
    groups.set(p.by, list);
  }
  return [...groups.entries()]
    .map(([by, ps]) => ({
      by,
      n: ps.length,
      brier: ps.reduce((a, p) => a + brier(p), 0) / ps.length,
      // How confident they were in whichever direction they leaned.
      meanConfidence:
        ps.reduce((a, p) => a + Math.max(p.priorConfirmed, 1 - p.priorConfirmed), 0) / ps.length,
      accuracy:
        ps.filter((p) => (p.priorConfirmed >= 0.5 ? 1 : 0) === actualValue(p)).length / ps.length,
    }))
    .sort((a, b) => a.brier - b.brier);
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
  predicted: number;
  actual: number;
}

/** Standard reliability bins: within each, stated confidence vs observed rate. */
export function calibrationCurve(findings: Finding[], bins = 5): CalibrationBin[] {
  const ps = scorablePredictions(findings);
  const width = 1 / bins;
  return Array.from({ length: bins }, (_, i) => {
    const lower = i * width;
    const upper = lower + width;
    const inBin = ps.filter(
      (p) => p.priorConfirmed >= lower && (i === bins - 1 ? p.priorConfirmed <= upper : p.priorConfirmed < upper),
    );
    return {
      lower,
      upper,
      n: inBin.length,
      predicted: inBin.length ? inBin.reduce((a, p) => a + p.priorConfirmed, 0) / inBin.length : 0,
      actual: inBin.length ? inBin.reduce((a, p) => a + actualValue(p), 0) / inBin.length : 0,
    };
  });
}

export interface CorpusCalibration {
  n: number;
  brier: number;
  accuracy: number;
  meanConfidence: number;
  /** Positive means better than refusing to guess; negative means worse. */
  edgeOverUninformed: number;
  /** All scored predictions are sealed by construction; kept for the API shape. */
  sealedShare: number;
}

export function corpusCalibration(findings: Finding[]): CorpusCalibration {
  const ps = scorablePredictions(findings);
  if (ps.length === 0) {
    return { n: 0, brier: 0, accuracy: 0, meanConfidence: 0, edgeOverUninformed: 0, sealedShare: 0 };
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
