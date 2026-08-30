import { NextResponse } from 'next/server';
import { loadCorpus } from '@/lib/cairn/load';
import { surprise, isScorable, brier, actualValue } from '@/lib/cairn/calibration';
import { confidence } from '@/lib/cairn/decay';

export const dynamic = 'force-dynamic';

/**
 * The corpus as supervised pairs, ranked by surprise.
 *
 * Each row is a forecast a model committed to before seeing the result,
 * paired with the outcome an executable check adjudicated. The `surprise`
 * field is the ranking signal that matters: a finding every predictor got
 * right is already in the weights and teaches nothing, while one confident
 * predictors got wrong is, by construction, knowledge the model population
 * lacks.
 *
 * ?minSurprise=0.5 selects for exactly that.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minSurprise = Number(searchParams.get('minSurprise') ?? 0);
  const blindOnly = searchParams.get('blindOnly') !== 'false';

  const rows = loadCorpus().flatMap((f) => {
    const s = surprise(f);
    if (s === null || s < minSurprise) return [];
    return f.predictions
      .filter(isScorable)
      .filter((p) => (blindOnly ? p.blind : true))
      .map((p) => ({
        findingId: f.id,
        subject: f.subject,
        scope: f.scope,
        claim: f.claim,
        expectation: f.expectation,
        reality: f.reality,
        mechanism: f.mechanism ?? null,
        check: f.check,
        evidence: f.evidence,
        prediction: {
          by: p.by,
          priorConfirmed: p.priorConfirmed,
          reasoning: p.reasoning,
          blind: p.blind,
          at: p.at,
        },
        outcome: p.outcome,
        actual: actualValue(p),
        brier: Number(brier(p).toFixed(4)),
        surprise: Number(s.toFixed(3)),
        currentConfidence: Number(confidence(f).toFixed(3)),
      }));
  });

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    count: rows.length,
    note:
      'Each row pairs a forecast committed before verification with an outcome ' +
      'adjudicated by executing check.command. Rank by `surprise` to select for ' +
      'knowledge the model population does not already hold. Predictions are ' +
      'blinded at collection: the forecaster did not see evidence or prior ' +
      'observations. This cannot be reconstructed from scraped text.',
    caveat:
      'Findings enter this corpus because someone found them surprising, so ' +
      'calibration measured here is calibration on selected hard cases, not ' +
      'general calibration. Do not read it as a model-wide accuracy figure.',
    rows: rows.sort((a, b) => b.surprise - a.surprise),
  });
}
