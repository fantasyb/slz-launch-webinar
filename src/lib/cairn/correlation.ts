import type { Finding } from './schema';
import { isScorableIn, actualValue, brier, type Resolved } from './calibration';

/**
 * Do rival models share blind spots?
 *
 * Nobody has this data, because collecting it requires a neutral party: a lab
 * can measure its own model but cannot credibly publish a calibration ledger
 * across its competitors. The two possible answers are both worth publishing.
 *
 *   Correlated errors — five models trained on overlapping internet all land
 *   at high confidence on the same wrong claim. That is not five failures,
 *   it is evidence the overconfidence lives in the training distribution
 *   itself, and it says something about what scraped text does not contain.
 *
 *   Uncorrelated errors — each model is individually miscalibrated but their
 *   mistakes are independent, so the mean forecast across rivals beats every
 *   member. An ensemble of competitors is then a better instrument than any
 *   lab's own model, which is a different and equally publishable result.
 *
 * `ensembleAdvantage` is the number that separates them.
 */

export interface FindingForecasts {
  finding: Finding;
  /** Signed error per predictor: prior - actual. Positive = too optimistic. */
  errors: Map<string, number>;
  priors: Map<string, number>;
  actual: 0 | 1;
  /** Mean prior across the panel — the ensemble's forecast. */
  ensemblePrior: number;
  ensembleBrier: number;
  /** Every panellist confident in the same direction, and all wrong. */
  sharedBlindSpot: boolean;
}

const CONFIDENT = 0.7;

export function forecastsByFinding(findings: Finding[], minPanel = 2): FindingForecasts[] {
  return findings.flatMap((f) => {
    // isScorableIn, not isScorable: the finding's own author knew the answer,
    // scores a perfect Brier, becomes bestMember, and biases ensembleAdvantage
    // negative — reporting "the ensemble loses to the best single model" when
    // the best single model was reading the answer key.
    let scored = f.predictions.filter((p): p is Resolved => isScorableIn(f, p));
    // One predictor may not constitute a panel by predicting twice.
    const seen = new Set<string>();
    scored = scored.filter((p) => (seen.has(p.by) ? false : (seen.add(p.by), true)));
    // Every prediction on a finding must agree about what happened; if they do
    // not, the row's `actual` would be whichever record sorted first.
    const outcomes = new Set(scored.map((p) => p.outcome));
    if (outcomes.size > 1) return [];
    if (scored.length < minPanel) return [];

    const actual = actualValue(scored[0]);
    const errors = new Map<string, number>();
    const priors = new Map<string, number>();
    for (const p of scored) {
      errors.set(p.by, p.priorConfirmed - actual);
      priors.set(p.by, p.priorConfirmed);
    }

    const ensemblePrior = scored.reduce((a, p) => a + p.priorConfirmed, 0) / scored.length;
    const allConfident = scored.every((p) => Math.max(p.priorConfirmed, 1 - p.priorConfirmed) >= CONFIDENT);
    const allWrong = scored.every((p) => (p.priorConfirmed >= 0.5 ? 1 : 0) !== actual);

    return [{
      finding: f,
      errors,
      priors,
      actual,
      ensemblePrior,
      ensembleBrier: Math.pow(ensemblePrior - actual, 2),
      sharedBlindSpot: allConfident && allWrong,
    }];
  });
}

/** Pearson correlation over the findings both predictors forecast. */
export function pairwiseCorrelation(
  rows: FindingForecasts[],
  a: string,
  b: string,
): { r: number; n: number } | null {
  const pairs = rows
    .filter((r) => r.errors.has(a) && r.errors.has(b))
    .map((r) => [r.errors.get(a)!, r.errors.get(b)!] as const);
  if (pairs.length < 3) return null;

  const n = pairs.length;
  const ma = pairs.reduce((s, [x]) => s + x, 0) / n;
  const mb = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (const [x, y] of pairs) {
    num += (x - ma) * (y - mb);
    da += (x - ma) ** 2;
    db += (y - mb) ** 2;
  }
  // A constant error series has zero variance and no correlation is defined.
  // Testing `den === 0` was not enough: the mean of three copies of 0.1 is
  // 0.10000000000000002, so the deviations are ~1e-17 rather than 0, the guard
  // is skipped, and the ratio of two residues is exactly +/-1 with a
  // noise-determined sign. Constant series are ordinary here — error is
  // prior minus actual, and actual is 0 or 1 — so the published verdict was
  // computable from which side of an ulp two rounding errors landed.
  const EPSILON = 1e-12;
  if (da < EPSILON || db < EPSILON) return null;
  return { r: num / Math.sqrt(da * db), n };
}

export interface PanelAnalysis {
  panelists: string[];
  findingsWithPanel: number;
  sharedBlindSpots: Array<{ id: string; title: string; ensemblePrior: number; actual: 0 | 1 }>;
  pairs: Array<{ a: string; b: string; r: number; n: number }>;
  meanCorrelation: number | null;
  memberBrier: Array<{ by: string; brier: number; n: number }>;
  ensembleBrier: number | null;
  /** Positive means the mean of rivals beats the best single model. */
  ensembleAdvantage: number | null;
  verdict: 'correlated' | 'independent' | 'insufficient-data';
}

export function analysePanel(findings: Finding[]): PanelAnalysis {
  const rows = forecastsByFinding(findings);
  const panelists = [...new Set(rows.flatMap((r) => [...r.errors.keys()]))].sort();

  const pairs: PanelAnalysis['pairs'] = [];
  for (let i = 0; i < panelists.length; i++) {
    for (let j = i + 1; j < panelists.length; j++) {
      const c = pairwiseCorrelation(rows, panelists[i], panelists[j]);
      if (c) pairs.push({ a: panelists[i], b: panelists[j], ...c });
    }
  }

  const memberBrier = panelists.map((by) => {
    // Score members on the same findings the ensemble is scored on, or the
    // comparison is between averages over different supports.
    const mine = rows.flatMap((r) =>
      r.finding.predictions.filter((p): p is Resolved => isScorableIn(r.finding, p) && p.by === by),
    );
    return { by, n: mine.length, brier: mine.reduce((a, p) => a + brier(p), 0) / (mine.length || 1) };
  });

  const ensembleBrier = rows.length
    ? rows.reduce((a, r) => a + r.ensembleBrier, 0) / rows.length
    : null;
  // A member needs enough forecasts to be a credible comparator; otherwise one
  // lucky n=1 row becomes the benchmark the ensemble is judged against.
  const MIN_MEMBER_N = 5;
  const eligible = memberBrier.filter((m) => m.n >= MIN_MEMBER_N);
  const bestMember = eligible.length ? Math.min(...eligible.map((m) => m.brier)) : null;
  const meanCorrelation = pairs.length
    ? pairs.reduce((a, p) => a + p.r, 0) / pairs.length
    : null;

  let verdict: PanelAnalysis['verdict'] = 'insufficient-data';
  if (rows.length >= 10 && meanCorrelation !== null) {
    verdict = meanCorrelation >= 0.4 ? 'correlated' : 'independent';
  }

  return {
    panelists,
    findingsWithPanel: rows.length,
    sharedBlindSpots: rows
      .filter((r) => r.sharedBlindSpot)
      .map((r) => ({
        id: r.finding.id,
        title: r.finding.title,
        ensemblePrior: r.ensemblePrior,
        actual: r.actual,
      })),
    pairs,
    meanCorrelation,
    memberBrier,
    ensembleBrier,
    ensembleAdvantage:
      ensembleBrier !== null && bestMember !== null ? bestMember - ensembleBrier : null,
    verdict,
  };
}
