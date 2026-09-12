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

/**
 * Correlation of two predictors' errors, CONTROLLING FOR THE OUTCOME.
 *
 * Error is `prior - actual`, so both series share the `actual` term; its
 * variance (~0.25 on balanced outcomes) dominates the covariance, and the raw
 * Pearson r came out strongly positive even for predictors whose priors are
 * independent noise — so "correlated: a shared blind spot" fired on nothing.
 * The shared term is removed by residualising within each outcome stratum
 * (subtract the mean error among rows with the same `actual`, then correlate the
 * pooled residuals): a partial correlation controlling for `actual`, which is
 * what "do they err together, BEYOND what the outcome forces" actually asks.
 */
export function pairwiseCorrelation(
  rows: FindingForecasts[],
  a: string,
  b: string,
): { r: number; n: number } | null {
  const byOutcome = new Map<number, Array<[number, number]>>();
  for (const r of rows) {
    if (!r.errors.has(a) || !r.errors.has(b)) continue;
    const arr = byOutcome.get(r.actual) ?? [];
    arr.push([r.errors.get(a)!, r.errors.get(b)!]);
    byOutcome.set(r.actual, arr);
  }
  const pairs: Array<[number, number]> = [];
  for (const arr of byOutcome.values()) {
    const k = arr.length;
    const sa = arr.reduce((s, [x]) => s + x, 0) / k;
    const sb = arr.reduce((s, [, y]) => s + y, 0) / k;
    for (const [x, y] of arr) pairs.push([x - sa, y - sb]); // deviation within the outcome stratum
  }
  if (pairs.length < 3) return null;

  const n = pairs.length;
  // Residual means are ~0 by construction, but keep the general form.
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
  /**
   * Per member: their Brier over the rows they forecast, and the ensemble's
   * Brier over those same rows. `null` at n=0 rather than 0, which would read
   * as a perfect score.
   */
  memberBrier: Array<{
    by: string;
    brier: number | null;
    n: number;
    ensembleOnSameRows: number | null;
  }>;
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

  // Each member scored on the rows they actually forecast, and the ensemble
  // re-scored on that same subset for the comparison below. Averaging the
  // member over their rows and the ensemble over ALL rows compared two numbers
  // computed on different supports, so a member who only forecast the easy
  // findings could "beat" an ensemble carrying the hard ones — a difference in
  // which questions were answered, reported as a difference in skill.
  //
  // `r.errors` is the deduplicated per-row view; re-filtering the finding's
  // predictions re-admitted duplicate same-`by` forecasts the row had already
  // collapsed.
  const memberBrier = panelists.map((by) => {
    const mineRows = rows.filter((r) => r.errors.has(by));
    const n = mineRows.length;
    const err = mineRows.reduce((a, r) => a + Math.pow(r.errors.get(by)!, 2), 0);
    const ensembleOnMine = n
      ? mineRows.reduce((a, r) => a + r.ensembleBrier, 0) / n
      : null;
    return { by, n, brier: n ? err / n : null, ensembleOnSameRows: ensembleOnMine };
  });

  const ensembleBrier = rows.length
    ? rows.reduce((a, r) => a + r.ensembleBrier, 0) / rows.length
    : null;
  // A member needs enough forecasts to be a credible comparator; otherwise one
  // lucky n=1 row becomes the benchmark the ensemble is judged against.
  const MIN_MEMBER_N = 5;
  const eligible = memberBrier.filter(
    (m): m is typeof m & { brier: number; ensembleOnSameRows: number } =>
      m.n >= MIN_MEMBER_N && m.brier !== null && m.ensembleOnSameRows !== null,
  );
  // The best member, and the ensemble measured on exactly that member's rows.
  const best = eligible.length
    ? eligible.reduce((a, b) => (b.brier < a.brier ? b : a))
    : null;
  const bestMember = best ? best.brier : null;
  const meanCorrelation = pairs.length
    ? pairs.reduce((a, p) => a + p.r, 0) / pairs.length
    : null;

  // The verdict is gated on the support the CORRELATIONS actually have, not on
  // how many rows the panel produced.
  //
  // `rows.length >= 10` and `meanCorrelation` measure different things: a pair
  // whose errors are constant yields no correlation and drops out of the mean,
  // while its rows still count toward the gate. Ten rows of which seven were
  // carried by pairs that dropped out published `correlated` from a single
  // pair with n=3 — a headline claim about the model population resting on
  // three points, with 70% of the evidence silently excluded.
  const MIN_PAIRS = 2;
  const MIN_PAIRWISE_SUPPORT = 10;
  const pairwiseSupport = pairs.reduce((a, p) => a + p.n, 0);

  let verdict: PanelAnalysis['verdict'] = 'insufficient-data';
  if (
    rows.length >= 10 &&
    meanCorrelation !== null &&
    pairs.length >= MIN_PAIRS &&
    pairwiseSupport >= MIN_PAIRWISE_SUPPORT
  ) {
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
    // Like for like: the best member against the ensemble on that member's own
    // rows, never against the ensemble's average over rows they never saw.
    ensembleAdvantage: best ? best.brier - best.ensembleOnSameRows : null,
    verdict,
  };
}
