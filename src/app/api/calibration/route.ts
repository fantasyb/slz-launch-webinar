import { NextResponse } from 'next/server';
import { publicCorpus } from '@/lib/cairn/load';
import {
  corpusCalibration,
  calibrationByBasis,
  scoreByModel,
  calibrationCurve,
  surprise,
  UNINFORMED_BRIER,
} from '@/lib/cairn/calibration';

export const dynamic = 'force-dynamic';

export async function GET() {
  const corpus = publicCorpus();
  const overall = corpusCalibration(corpus);
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    uninformedBaseline: UNINFORMED_BRIER,
    overall,
    byBasis: calibrationByBasis(corpus),
    byBasisNote:
      'Empirical claims test knowledge of how a system behaves; structural claims test ' +
      'reasoning from a design the model already knows. Pooling them measures neither.',
    byModel: scoreByModel(corpus),
    curve: calibrationCurve(corpus),
    mostSurprising: corpus
      .map((f) => ({ id: f.id, title: f.title, surprise: surprise(f) }))
      .filter((r): r is { id: string; title: string; surprise: number } => r.surprise !== null)
      .sort((a, b) => b.surprise - a.surprise),
    caveat:
      'Small n, and findings are selected for being surprising. This measures ' +
      'calibration on hard cases, not general model accuracy.',
  });
}
