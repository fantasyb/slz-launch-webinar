export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFinding } from '@/lib/cairn/load';
import {
  confidence,
  standing,
  freshness,
  corroboration,
  confirmationCount,
  lastConfirmedAt,
  formatConfidence,
  environmentCount,
  scopeSupport,
} from '@/lib/cairn/decay';
import { StandingBadge, ConfidenceStack, ProvenanceMark, standingHint } from '@/components/Standing';
import { relativeDays, cn } from '@/lib/utils';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const f = getFinding((await params).id);
  return { title: f ? `${f.title} — Cairn` : 'Not found — Cairn' };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule py-6">
      <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="evidence rounded-md border border-rule bg-paper p-3 font-mono text-[12px] leading-relaxed text-ink-soft">
      {children}
    </pre>
  );
}

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const f = getFinding((await params).id);
  if (!f) notFound();

  const c = confidence(f);
  const s = standing(f);
  const confirmedAt = lastConfirmedAt(f);

  return (
    <article className="mx-auto max-w-3xl px-5 py-12">
      <Link href="/findings" className="text-[12px] text-ink-faint hover:text-ink">
        &larr; findings
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-faint">
        <span className="font-mono">{f.id}</span>
        <span className="text-rule-strong">·</span>
        <span>{f.kind}</span>
        <span className="text-rule-strong">·</span>
        <span className="font-mono">
          {f.subject.name} <span className="text-rule-strong">/</span> {f.subject.ecosystem}
        </span>
        <span className="text-rule-strong">·</span>
        <span>versions {f.subject.versions}</span>
      </div>

      <h1 className="font-claim mt-2 text-2xl leading-tight tracking-tight">{f.title}</h1>

      {f.status === 'retired' && (
        <div className="mt-5 rounded-md border border-slate/30 bg-slate-soft p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate">Retired</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{f.retiredReason}</p>
        </div>
      )}

      <p className="font-claim mt-5 border-l-2 border-moss pl-4 text-[17px] leading-relaxed text-ink">
        {f.claim}
      </p>

      {/* Confidence panel */}
      <div className="mt-7 rounded-lg border border-rule bg-raised p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <ConfidenceStack value={c} />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-claim text-2xl">{formatConfidence(c)}</span>
                <StandingBadge standing={s} />
              </div>
              <p className="mt-1 text-[12px] text-ink-faint">{standingHint(s)}</p>
            </div>
          </div>
          <ProvenanceMark provenance={f.provenance} />
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-rule pt-4 text-[12px] sm:grid-cols-5">
          <div>
            <dt className="text-ink-faint">Freshness</dt>
            <dd className="mt-0.5 font-mono text-ink">{formatConfidence(freshness(f))}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Corroboration</dt>
            <dd className="mt-0.5 font-mono text-ink">
              {formatConfidence(corroboration(f))}{' '}
              <span className="text-ink-faint">({confirmationCount(f)})</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint">Environments</dt>
            <dd className="mt-0.5 font-mono text-ink">
              {environmentCount(f)}{' '}
              <span className="text-ink-faint">
                (&times;{scopeSupport(f).toFixed(2)})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint">Half-life</dt>
            <dd className="mt-0.5 font-mono text-ink">{f.halfLifeDays}d</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Last confirmed</dt>
            <dd className="mt-0.5 font-mono text-ink">
              {confirmedAt ? relativeDays(confirmedAt) : 'never'}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          Confidence halves every {f.halfLifeDays} days without a fresh check. Corroboration
          counts distinct observers and saturates, because the tenth confirmation says far
          less than the second.{' '}
          {f.scope === 'universal' ? (
            <>
              This claims <strong className="text-ink-soft">universal</strong> scope, so it is
              multiplied by {scopeSupport(f).toFixed(2)} until confirmed across more
              environments &mdash; a universal claim standing on{' '}
              {environmentCount(f) === 1 ? 'one environment' : `${environmentCount(f)} environments`}{' '}
              has not yet earned the word.
            </>
          ) : (
            <>
              This claims scope only over its stated environment, so breadth is not owed.
            </>
          )}
        </p>
      </div>

      {f.scope === 'environment-specific' && f.appliesTo && (
        <div className="mt-5 rounded-md border border-slate/25 bg-slate-soft p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate">
            Applies to
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{f.appliesTo}</p>
        </div>
      )}

      <Section title="What you would expect">
        <p className="text-[14px] leading-relaxed text-ink-soft">{f.expectation}</p>
      </Section>

      <Section title="What actually happens">
        <p className="text-[14px] leading-relaxed text-ink">{f.reality}</p>
      </Section>

      {f.mechanism && (
        <Section title="Why">
          <p className="text-[14px] leading-relaxed text-ink-soft">{f.mechanism}</p>
        </Section>
      )}

      {f.workaround && (
        <Section title="What to do instead">
          <p className="text-[14px] leading-relaxed text-ink">{f.workaround}</p>
        </Section>
      )}

      {f.evidence.length > 0 && (
        <Section title="Evidence">
          <div className="space-y-4">
            {f.evidence.map((e, i) => (
              <div key={i}>
                <Code>
                  <span className="select-none text-ink-faint">$ </span>
                  {e.command}
                  {e.output && `\n${e.output}`}
                </Code>
                {e.note && (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">{e.note}</p>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Re-verify this">
        <p className="mb-2.5 text-[13px] leading-relaxed text-ink-soft">
          {f.check.manual
            ? 'This check needs a human, a specific host, or a paid API. It cannot be run unattended.'
            : 'Cheap, hermetic, side-effect free. Run it and open a pull request with what you saw.'}
        </p>
        <Code>
          <span className="select-none text-ink-faint">$ </span>
          {f.check.command}
        </Code>
        <dl className="mt-3 space-y-2 text-[13px]">
          <div className="flex gap-2.5">
            <dt className="shrink-0 font-medium text-moss">Confirmed if</dt>
            <dd className="text-ink-soft">{f.check.confirmedIf}</dd>
          </div>
          <div className="flex gap-2.5">
            <dt className="shrink-0 font-medium text-rust">Refuted if</dt>
            <dd className="text-ink-soft">{f.check.refutedIf}</dd>
          </div>
        </dl>
        <Code>
          <span className="select-none text-ink-faint">$ </span>
          npm run cairn:verify {f.id}
        </Code>
      </Section>

      <Section title={`Observations (${f.observations.length})`}>
        <ol className="space-y-4">
          {[...f.observations]
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
            .map((o, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    o.verdict === 'confirmed' && 'bg-moss',
                    o.verdict === 'refuted' && 'bg-rust',
                    o.verdict === 'inconclusive' && 'bg-ochre',
                  )}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                    <span className="font-medium text-ink">{o.verdict}</span>
                    <span className="font-mono text-ink-faint">{o.by}</span>
                    <span className="text-ink-faint">{relativeDays(o.at)}</span>
                  </div>
                  {o.note && (
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{o.note}</p>
                  )}
                  {o.environment ? (
                    <p className="mt-1 font-mono text-[11px] text-ink-faint">
                      {[o.environment.os, o.environment.arch, o.environment.runtime]
                        .filter(Boolean)
                        .join(' · ')}
                      {o.environment.note && ` — ${o.environment.note}`}
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] italic text-ink-faint">
                      not executed — contributes no breadth
                    </p>
                  )}
                </div>
              </li>
            ))}
        </ol>
      </Section>

      <Section title="Tags">
        <div className="flex flex-wrap gap-1.5">
          {f.tags.map((t) => (
            <Link
              key={t}
              href={`/findings?q=${encodeURIComponent(t)}`}
              className="rounded-full border border-rule px-2.5 py-1 font-mono text-[11px] text-ink-soft hover:border-rule-strong"
            >
              {t}
            </Link>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-ink-faint">
          Rediscovering this from scratch costs roughly{' '}
          <span className="font-medium text-ink-soft">{f.cost}</span>. Machine-readable at{' '}
          <Link href={`/api/findings/${f.id}`} className="font-mono underline hover:text-ink-soft">
            /api/findings/{f.id}
          </Link>
          .
        </p>
      </Section>
    </article>
  );
}
