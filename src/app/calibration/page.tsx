export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { loadCorpus } from '@/lib/cairn/load';
import {
  corpusCalibration,
  scoreByModel,
  calibrationCurve,
  surprise,
  scorablePredictions,
  brier,
  actualValue,
  UNINFORMED_BRIER,
} from '@/lib/cairn/calibration';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Calibration — Cairn' };

export default function CalibrationPage() {
  const corpus = loadCorpus();
  const overall = corpusCalibration(corpus);
  const models = scoreByModel(corpus);
  const curve = calibrationCurve(corpus).filter((b) => b.n > 0);
  const preds = scorablePredictions(corpus).sort((a, b) => brier(b) - brier(a));
  const ranked = corpus
    .map((f) => ({ f, s: surprise(f) }))
    .filter((r): r is { f: (typeof corpus)[number]; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s);

  const worseThanGuessing = overall.edgeOverUninformed < 0;

  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="font-claim text-2xl leading-tight tracking-tight">
        What the corpus knows that the models do not.
      </h1>
      <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-ink-soft">
        <p>
          A finding on its own is a fact, and facts can be scraped. What cannot be scraped
          is a forecast committed <em>before</em> the answer was known, adjudicated by
          running a command. Every check here can be preceded by a blinded prediction: the
          forecaster sees the claim and the check, never the evidence or prior
          observations.
        </p>
        <p>
          That produces something no corpus of documentation contains &mdash; a measurement
          of the gap between what a model believed and what was true, with an executable
          arbiter in between.
        </p>
      </div>

      {/* Headline */}
      <div className="mt-8 rounded-lg border border-rule bg-raised p-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          {[
            { k: 'predictions', v: String(overall.n) },
            { k: 'mean confidence', v: `${Math.round(overall.meanConfidence * 100)}%` },
            { k: 'accuracy', v: `${Math.round(overall.accuracy * 100)}%` },
            { k: 'brier score', v: overall.brier.toFixed(3) },
          ].map(({ k, v }) => (
            <div key={k}>
              <div className="font-claim text-2xl text-ink">{v}</div>
              <div className="mt-0.5 text-[11px] uppercase tracking-wider text-ink-faint">{k}</div>
            </div>
          ))}
        </div>
        <p
          className={cn(
            'mt-5 border-t border-rule pt-4 text-[13px] leading-relaxed',
            worseThanGuessing ? 'text-rust' : 'text-moss',
          )}
        >
          {worseThanGuessing ? (
            <>
              <strong className="font-semibold">
                Worse than declining to guess.
              </strong>{' '}
              Always predicting 50% scores {UNINFORMED_BRIER}; these predictions score{' '}
              {overall.brier.toFixed(3)}, an edge of{' '}
              {overall.edgeOverUninformed.toFixed(3)}. Stated confidence averaged{' '}
              {Math.round(overall.meanConfidence * 100)}% while accuracy was{' '}
              {Math.round(overall.accuracy * 100)}%. That gap is the asset.
            </>
          ) : (
            <>
              Beating the uninformed baseline of {UNINFORMED_BRIER} by{' '}
              {overall.edgeOverUninformed.toFixed(3)}.
            </>
          )}
        </p>
      </div>

      <p className="mt-4 rounded-md border border-ochre/25 bg-ochre-soft p-3 text-[12px] leading-relaxed text-ink-soft">
        <strong className="font-semibold text-ochre">Read this honestly.</strong> n ={' '}
        {overall.n}, and findings enter the corpus <em>because</em> someone found them
        surprising. This is calibration on selected hard cases, not a model-wide accuracy
        figure. The value is in the mechanism and what it yields at scale, not in this
        sample.
      </p>

      {/* Reliability */}
      {curve.length > 0 && (
        <section className="mt-10">
          <h2 className="font-claim text-lg">Reliability</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
            Within each confidence band, stated confidence against the rate that actually
            held. Bars that fall short of the marker are overconfidence.
          </p>
          <div className="mt-5 space-y-3">
            {curve.map((b) => (
              <div key={b.lower} className="flex items-center gap-3">
                <span className="w-16 shrink-0 font-mono text-[11px] text-ink-faint">
                  {Math.round(b.lower * 100)}&ndash;{Math.round(b.upper * 100)}%
                </span>
                <div className="relative h-6 flex-1 overflow-hidden rounded border border-rule bg-paper">
                  <div
                    className="h-full bg-moss/70"
                    style={{ width: `${b.actual * 100}%` }}
                  />
                  <div
                    className="absolute top-0 h-full w-[2px] bg-ink"
                    style={{ left: `calc(${b.predicted * 100}% - 1px)` }}
                    title={`stated ${Math.round(b.predicted * 100)}%`}
                  />
                </div>
                <span className="w-28 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                  {Math.round(b.actual * 100)}% of {b.n}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-ink-faint">
            Bar = observed rate. Vertical line = mean stated confidence.
          </p>
        </section>
      )}

      {/* Per model */}
      <section className="mt-10">
        <h2 className="font-claim text-lg">By predictor</h2>
        <div className="evidence mt-4">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-rule text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="pb-2 pr-4 font-medium">predictor</th>
                <th className="pb-2 pr-4 font-medium">n</th>
                <th className="pb-2 pr-4 font-medium">confidence</th>
                <th className="pb-2 pr-4 font-medium">accuracy</th>
                <th className="pb-2 font-medium">brier</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.by} className="border-b border-rule/60">
                  <td className="py-2.5 pr-4 font-mono text-[12px]">{m.by}</td>
                  <td className="py-2.5 pr-4 font-mono text-ink-soft">{m.n}</td>
                  <td className="py-2.5 pr-4 font-mono text-ink-soft">
                    {Math.round(m.meanConfidence * 100)}%
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-ink-soft">
                    {Math.round(m.accuracy * 100)}%
                  </td>
                  <td
                    className={cn(
                      'py-2.5 font-mono',
                      m.brier > UNINFORMED_BRIER ? 'text-rust' : 'text-moss',
                    )}
                  >
                    {m.brier.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Surprise ranking */}
      <section className="mt-10">
        <h2 className="font-claim text-lg">Ranked by surprise</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          Mean prediction error across everyone who forecast it. A finding every predictor
          got right is already in the weights and teaches nothing. One that confident
          predictors got wrong is, by construction, knowledge the models do not have.{' '}
          <strong className="font-semibold text-ink">
            This is the ranking that selects training signal.
          </strong>
        </p>
        <div className="mt-5 space-y-2">
          {ranked.map(({ f, s }) => (
            <Link
              key={f.id}
              href={`/findings/${f.id}`}
              className="flex items-center gap-4 rounded-md border border-rule bg-raised p-3 transition-colors hover:border-rule-strong"
            >
              <div className="h-10 w-1.5 shrink-0 overflow-hidden rounded-full bg-rule">
                <div
                  className="w-full bg-rust"
                  style={{ height: `${s * 100}%`, marginTop: `${(1 - s) * 100}%` }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-ink-faint">{f.id}</div>
                <div className="truncate font-claim text-[14px] text-ink">{f.title}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[15px] text-ink">{s.toFixed(2)}</div>
                <div className="text-[10px] uppercase tracking-wider text-ink-faint">
                  surprise
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Individual predictions */}
      <section className="mt-10">
        <h2 className="font-claim text-lg">The ledger</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          Every forecast, worst first. Reasoning is recorded because the reasoning is the
          part worth training on, not the number.
        </p>
        <ol className="mt-5 space-y-4">
          {preds.map((p, i) => {
            const wrong = brier(p) > 0.25;
            return (
              <li key={i} className="rounded-md border border-rule bg-raised p-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    href={`/findings/${p.findingId}`}
                    className="font-mono text-[12px] underline decoration-rule-strong underline-offset-2"
                  >
                    {p.findingId}
                  </Link>
                  <span className="font-mono text-[11px] text-ink-faint">{p.by}</span>
                  <span className="text-[12px] text-ink-soft">
                    predicted{' '}
                    <strong className="font-semibold text-ink">
                      {Math.round(p.priorConfirmed * 100)}%
                    </strong>{' '}
                    confirm &rarr; actually{' '}
                    <strong
                      className={cn('font-semibold', actualValue(p) ? 'text-moss' : 'text-rust')}
                    >
                      {p.outcome}
                    </strong>
                  </span>
                  <span
                    className={cn(
                      'ml-auto rounded-full border px-2 py-0.5 font-mono text-[11px]',
                      wrong
                        ? 'border-rust/30 bg-rust-soft text-rust'
                        : 'border-moss/30 bg-moss-soft text-moss',
                    )}
                  >
                    brier {brier(p).toFixed(3)}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{p.reasoning}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="mt-10 border-t border-rule pt-6">
        <h2 className="font-claim text-lg">Take the data</h2>
        <pre className="evidence mt-3 rounded-md border border-rule bg-paper p-3 font-mono text-[12px] text-ink-soft">
{`# every forecast/outcome pair, ranked by surprise
GET /api/training

# only what the models got wrong — the signal worth training on
GET /api/training?minSurprise=0.5

# scores, reliability curve, per-model breakdown
GET /api/calibration`}
        </pre>
      </section>
    </div>
  );
}
