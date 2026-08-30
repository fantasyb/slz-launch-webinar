import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { loadCorpus } from '@/lib/cairn/load';
import { surprise, isScorableIn, brier, actualValue } from '@/lib/cairn/calibration';
import { confidence } from '@/lib/cairn/decay';
import { numberParam, BadParam } from '@/lib/cairn/params';

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
  let minSurprise: number;
  try {
    minSurprise = numberParam(searchParams.get('minSurprise'), 0, { min: 0, max: 1 });
  } catch (e) {
    if (e instanceof BadParam) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  const rows = loadCorpus().flatMap((f) => {
    const s = surprise(f);
    if (s === null || s < minSurprise) return [];
    return f.predictions
      // isScorableIn, not isScorable: only the former applies the
      // self-prediction and body-binding checks. The note below has always
      // claimed a finding's own author is excluded; with the weaker predicate
      // they were in the export, so the flagship dataset contradicted its own
      // description of itself.
      .filter((p) => isScorableIn(f, p))
      .map((p) => ({
        findingId: f.id,
        subject: f.subject,
        scope: f.scope,
        basis: f.basis ?? 'empirical',
        derivation: f.derivation ?? null,
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
          at: p.at,
          sealedWith: p.commitment
            ? { hash: p.commitment.hash, anchor: p.commitment.anchor }
            : null,
        },
        outcome: p.outcome,
        actual: actualValue(p),
        brier: Number(brier(p).toFixed(4)),
        surprise: Number(s.toFixed(3)),
        currentConfidence: Number(confidence(f).toFixed(3)),
      }));
  });

  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    generatedAt: new Date().toISOString(),
    count: rows.length,
    note:
      'Each row pairs a forecast with an outcome adjudicated by executing ' +
      'check.command. Every row here is cryptographically sealed: the hash in ' +
      'sealedWith was published to git before the check ran, and recomputes ' +
      'from the revealed prior and reasoning, so the forecast provably could ' +
      'not have been edited to match its result. Unsealed self-reports and ' +
      'predictions by a finding\'s own author are excluded. Rank by `surprise` ' +
      'to select for knowledge the model population does not already hold.',
    basisNote:
      'Rows carry `basis`. Empirical rows measure knowledge of system behaviour; ' +
      'structural rows measure reasoning from a design. Train or evaluate on them ' +
      'separately — a single score over both measures neither.',
    caveat:
      'Findings enter this corpus because someone found them surprising, so ' +
      'calibration measured here is calibration on selected hard cases, not ' +
      'general calibration. Do not read it as a model-wide accuracy figure.',
    rows: rows.sort((a, b) => b.surprise - a.surprise),
  });
}
