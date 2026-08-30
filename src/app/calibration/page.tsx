export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { loadCorpus } from '@/lib/cairn/load';
import {
  corpusCalibration,
  scoreByModel,
  calibrationCurve,
  surprise,
  scorablePredictions,
  allPredictions,
  ledgerIntegrity,
  brier,
  actualValue,
  UNINFORMED_BRIER,
} from '@/lib/cairn/calibration';
import { analysePanel } from '@/lib/cairn/correlation';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Calibration — Cairn' };

export default function CalibrationPage() {
  const corpus = loadCorpus();
  const overall = corpusCalibration(corpus);
  const models = scoreByModel(corpus);
  const curve = calibrationCurve(corpus).filter((b) => b.n > 0);
  const preds = scorablePredictions(corpus).sort((a, b) => brier(b) - brier(a));
  const integrity = ledgerIntegrity(corpus);
  const unscored = allPredictions(corpus).filter((p) => !p.scorable);
  const panel = analysePanel(corpus);
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
          Blinding is enforced by commit&ndash;reveal, not by good manners. The seal
          publishes only a hash of the forecast to git; the prior and the reasoning stay
          secret until after the check has run. Anyone can recompute the hash, and{' '}
          <code className="font-mono text-[13px]">cairn:audit</code> walks git history to
          confirm the seal commit is an ancestor of the reveal. A forecast edited to match
          its outcome breaks its own hash and is never scored.
        </p>
      </div>

      {/* Integrity */}
      <div className="mt-8 rounded-lg border border-rule bg-raised p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Ledger integrity
        </p>
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
          {[
            { k: 'predictions', v: integrity.total, tone: 'text-ink' },
            { k: 'sealed & verified', v: integrity.verified, tone: 'text-moss' },
            { k: 'awaiting reveal', v: integrity.sealed, tone: 'text-ochre' },
            { k: 'unanchored', v: integrity.unanchored, tone: 'text-ink-faint' },
            { k: 'broken seals', v: integrity.broken, tone: integrity.broken ? 'text-rust' : 'text-ink-faint' },
            { k: 'scored', v: integrity.scored, tone: 'text-ink' },
          ].map(({ k, v, tone }) => (
            <div key={k}>
              <div className={cn('font-claim text-xl', tone)}>{v}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">{k}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 border-t border-rule pt-3 text-[12px] leading-relaxed text-ink-soft">
          Only sealed, revealed, hash-verified forecasts by someone other than the
          finding&rsquo;s author are scored. Everything else is shown and excluded. A corpus
          that scored its own author&rsquo;s unverifiable claims would be worth nothing.
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
        {overall.n}. Findings also enter the corpus <em>because</em> someone found them
        surprising, so this measures calibration on selected hard cases, never a model-wide
        accuracy figure. The asset is the mechanism and what it yields at scale. This sample
        proves only that the mechanism runs end to end.
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

      {/* Panel */}
      <section className="mt-10">
        <h2 className="font-claim text-lg">Do rival models share blind spots?</h2>
        <div className="mt-2 space-y-3 text-[14px] leading-relaxed text-ink-soft">
          <p>
            Nobody has this data, because collecting it requires a neutral party. A lab can
            measure its own model; it cannot credibly publish a calibration ledger across its
            competitors. Both possible answers are worth publishing.
          </p>
          <p>
            <strong className="font-semibold text-ink">Correlated errors</strong> would mean
            several models trained on overlapping internet land at high confidence on the same
            wrong claim &mdash; not several failures, but evidence that the overconfidence
            lives in the training distribution itself.{' '}
            <strong className="font-semibold text-ink">Uncorrelated errors</strong> would mean
            each model is miscalibrated but independently, so the mean forecast across rivals
            beats every member &mdash; an ensemble of competitors outperforming any single
            lab&rsquo;s model.
          </p>
        </div>

        {panel.verdict === 'insufficient-data' ? (
          <div className="mt-5 rounded-lg border border-dashed border-rule-strong p-6">
            <p className="text-[13px] leading-relaxed text-ink-soft">
              <strong className="font-semibold text-ink">Not yet run.</strong>{' '}
              {panel.findingsWithPanel} finding
              {panel.findingsWithPanel === 1 ? ' has' : 's have'} forecasts from two or more
              panelists; the analysis needs at least 10 before it reports a verdict. The
              harness is built and smoke-tested &mdash; it needs API keys and a run.
            </p>
            <pre className="evidence mt-3 rounded-md border border-rule bg-paper p-3 font-mono text-[12px] text-ink-soft">
{`npm run cairn:panel -- seal     # solicit, seal, write the manifest
git add cairn/ panel-runs/ && git commit && git push
npm run cairn:panel -- reveal   # after the checks have run`}
            </pre>
          </div>
        ) : (
          <>
            <div className="mt-5 rounded-lg border border-rule bg-raised p-5">
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <div>
                  <div className="font-claim text-2xl text-ink">
                    {panel.meanCorrelation?.toFixed(2) ?? '—'}
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                    mean error correlation
                  </div>
                </div>
                <div>
                  <div className="font-claim text-2xl text-ink">
                    {panel.ensembleBrier?.toFixed(3) ?? '—'}
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                    ensemble brier
                  </div>
                </div>
                <div>
                  <div
                    className={cn(
                      'font-claim text-2xl',
                      (panel.ensembleAdvantage ?? 0) > 0 ? 'text-moss' : 'text-ink',
                    )}
                  >
                    {panel.ensembleAdvantage !== null
                      ? (panel.ensembleAdvantage > 0 ? '+' : '') + panel.ensembleAdvantage.toFixed(3)
                      : '—'}
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                    ensemble vs best member
                  </div>
                </div>
                <div>
                  <div className="font-claim text-2xl text-ink">{panel.sharedBlindSpots.length}</div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                    shared blind spots
                  </div>
                </div>
              </div>
              <p className="mt-4 border-t border-rule pt-3 text-[13px] leading-relaxed text-ink-soft">
                {panel.verdict === 'correlated' ? (
                  <>
                    <strong className="font-semibold text-rust">Errors are correlated.</strong>{' '}
                    The panel tends to be wrong together, which points at the shared training
                    distribution rather than at any one model.
                  </>
                ) : (
                  <>
                    <strong className="font-semibold text-moss">Errors are independent.</strong>{' '}
                    Members are individually miscalibrated but miss in different directions, so
                    the mean of rivals is the better instrument.
                  </>
                )}
              </p>
            </div>

            {panel.pairs.length > 0 && (
              <div className="evidence mt-5">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-rule text-[11px] uppercase tracking-wider text-ink-faint">
                      <th className="pb-2 pr-4 font-medium">pair</th>
                      <th className="pb-2 pr-4 font-medium">n</th>
                      <th className="pb-2 font-medium">error correlation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panel.pairs.map((p) => (
                      <tr key={`${p.a}-${p.b}`} className="border-b border-rule/60">
                        <td className="py-2 pr-4 font-mono text-[12px]">
                          {p.a} · {p.b}
                        </td>
                        <td className="py-2 pr-4 font-mono text-ink-soft">{p.n}</td>
                        <td
                          className={cn('py-2 font-mono', p.r >= 0.4 ? 'text-rust' : 'text-moss')}
                        >
                          {p.r.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {panel.sharedBlindSpots.length > 0 && (
              <div className="mt-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Every panelist confident, every panelist wrong
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {panel.sharedBlindSpots.map((b) => (
                    <li key={b.id} className="rounded-md border border-rust/30 bg-rust-soft px-3 py-2 text-[12px]">
                      <Link href={`/findings/${b.id}`} className="font-mono underline">
                        {b.id}
                      </Link>{' '}
                      <span className="text-ink-soft">{b.title}</span>{' '}
                      <span className="font-mono text-rust">
                        panel said {Math.round(b.ensemblePrior * 100)}%, actual{' '}
                        {b.actual ? 'confirmed' : 'refuted'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* Excluded */}
      {unscored.length > 0 && (
        <section className="mt-10">
          <h2 className="font-claim text-lg">Recorded but not scored</h2>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
            Kept in full, because a discarded prediction is a hidden one. Excluded because
            nobody but their author can verify they preceded their outcomes.
          </p>
          <ul className="mt-4 space-y-2">
            {unscored.map((p, i) => (
              <li
                key={i}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed border-rule-strong px-3 py-2 text-[12px]"
              >
                <Link href={`/findings/${p.findingId}`} className="font-mono underline decoration-rule-strong underline-offset-2">
                  {p.findingId}
                </Link>
                <span className="font-mono text-ink-faint">{p.by}</span>
                {p.priorConfirmed !== undefined && (
                  <span className="text-ink-soft">
                    said {Math.round(p.priorConfirmed * 100)}% &rarr; {p.outcome}
                  </span>
                )}
                <span className="ml-auto flex gap-1.5">
                  <span className="rounded-full border border-rule px-2 py-0.5 font-mono text-[11px] text-ink-faint">
                    {p.status}
                  </span>
                  {p.self && (
                    <span className="rounded-full border border-rust/30 bg-rust-soft px-2 py-0.5 font-mono text-[11px] text-rust">
                      self
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
{`# verify the ordering yourself, against git
npm run cairn:audit

# every forecast/outcome pair, ranked by surprise
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
