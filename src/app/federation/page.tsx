export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { loadFederated, loadConfig, federationSummary } from '@/lib/cairn/federation';
import { loadKeys } from '@/lib/cairn/keys';
import { confidence, standing, effectiveEnvironments } from '@/lib/cairn/decay';
import { StandingBadge, ConfidenceStack } from '@/components/Standing';
import { formatConfidence } from '@/lib/cairn/decay';
import { relativeDays, formatEnvironments } from '@/lib/utils';

export const metadata = { title: 'Federation — Cairn' };

export default function FederationPage() {
  const config = loadConfig();
  const federated = loadFederated();
  const summary = federationSummary();
  const keys = [...loadKeys().values()];

  return (
    <div className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="font-claim text-2xl leading-tight tracking-tight">
        Upstream knowledge, scored by your own evidence.
      </h1>
      <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-ink-soft">
        <p>
          The naive shared corpus is one database everyone writes to, which fails on trust
          and relevance at once: you inherit everyone&rsquo;s poisoning and everyone&rsquo;s
          environment-specific noise.
        </p>
        <p>
          Instead, upstream findings are pulled read-only and your observations attach as an
          overlay. The confidence you see combines their evidence with yours, so{' '}
          <strong className="font-semibold text-ink">
            a confirmation in your environment changes your score immediately
          </strong>{' '}
          &mdash; no waiting on upstream to merge anything. Send the overlay file as a pull
          request and it changes theirs too.
        </p>
        <p>
          This is why signing came first. A federated observation arrives from a repository
          you do not control; without signatures you would be merging unattributable claims
          from strangers directly into your own scoring.
        </p>
      </div>

      <div className="mt-8 rounded-lg border border-rule bg-raised p-5">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            { k: 'upstreams', v: summary.upstreams },
            { k: 'federated findings', v: summary.findings },
            { k: 'with local evidence', v: summary.withLocalEvidence },
            { k: 'unverified observations', v: summary.unverifiedObservations },
          ].map(({ k, v }) => (
            <div key={k}>
              <div className="font-claim text-xl text-ink">{v}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-faint">{k}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 border-t border-rule pt-3 font-mono text-[12px] text-ink-faint">
          this cairn publishes at{' '}
          <Link href="/api/federation" className="underline hover:text-ink-soft">
            /api/federation
          </Link>{' '}
          as <span className="text-ink-soft">{config.origin}</span>
        </p>
      </div>

      {federated.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-rule-strong p-8 text-center text-[13px] text-ink-faint">
          No upstreams pulled. Configure them in <span className="font-mono">cairn.config.json</span>{' '}
          and run <span className="font-mono">npm run cairn:federate</span>.
        </p>
      ) : (
        <section className="mt-10">
          <h2 className="font-claim text-lg">Federated findings</h2>
          <div className="mt-4 space-y-3">
            {federated.map((ff) => {
              const c = confidence(ff.finding);
              return (
                <div key={ff.displayId} className="rounded-lg border border-rule bg-raised p-5">
                  <div className="flex items-start gap-4">
                    <ConfidenceStack value={c} className="mt-1.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-faint">
                        <span className="font-mono text-slate">{ff.displayId}</span>
                        <span className="text-rule-strong">·</span>
                        <span className="truncate">{ff.origin}</span>
                      </div>
                      <h3 className="font-claim break-words text-[15px] leading-snug text-ink">
                        {ff.finding.title}
                      </h3>
                      <p className="mt-2 break-words text-[13px] leading-relaxed text-ink-soft">
                        {ff.finding.reality}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-ink-faint">
                        <StandingBadge standing={standing(ff.finding)} />
                        <span>{formatConfidence(c)}</span>
                        <span>{formatEnvironments(effectiveEnvironments(ff.finding))} env</span>
                        <span className="text-moss">{ff.verifiedUpstream} upstream signed</span>
                        {ff.unverifiedUpstream > 0 && (
                          <span className="text-rust">{ff.unverifiedUpstream} unverified</span>
                        )}
                      </div>
                      {/* The two halves of that row are computed against
                          different key sets, and printed side by side they read
                          as one figure explaining the other. The scores use
                          local keys deliberately — an upstream's signature
                          attests who spoke upstream, not that you accept them
                          as a corroborating party — so an upstream-signed
                          observation scores here exactly as an unsigned one
                          does. Saying so is the only thing that stops the badge
                          beside it from implying the opposite. */}
                      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                        Standing, confidence and breadth above are scored against your key
                        list alone.{' '}
                        {ff.verifiedUpstream > 0 && (
                          <>
                            {ff.verifiedUpstream === 1
                              ? 'The upstream signature beside them verifies against upstream’s keys rather than yours, so it counts toward those three numbers exactly as an unsigned observation would.'
                              : `The ${ff.verifiedUpstream} upstream signatures beside them verify against upstream’s keys rather than yours, so they count toward those three numbers exactly as unsigned observations would.`}{' '}
                          </>
                        )}
                        Upstream evidence earns full weight in your scores only once you hold
                        the key that signed it.
                      </p>

                      {ff.overlay.length > 0 && (
                        <div className="mt-4 rounded-md border border-moss/25 bg-moss-soft p-3">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-moss">
                            Your evidence ({ff.overlay.length})
                          </p>
                          {ff.overlay.map((o, i) => (
                            <div key={i} className="mt-2">
                              <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                                <span className="font-medium text-ink">{o.verdict}</span>
                                <span className="font-mono text-ink-faint">{o.by}</span>
                                <span className="text-ink-faint">{relativeDays(o.at)}</span>
                                {o.signature && (
                                  <span className="font-mono text-moss">signed</span>
                                )}
                              </div>
                              {o.note && (
                                <p className="mt-1 break-words text-[12px] leading-relaxed text-ink-soft">
                                  {o.note}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-10">
        <h2 className="font-claim text-lg">Known keys</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          The public key is the identity &mdash; no registry, no certificate authority.
          Verification needs nothing but a clone. Federating with an upstream means accepting
          its key list, so an upstream publishing a key under one of your own agents&rsquo;
          labels is refused at pull time.
        </p>
        <ul className="mt-4 space-y-1.5">
          {keys.map((k) => (
            <li
              key={k.keyId}
              className="flex flex-wrap items-center gap-x-3 rounded-md border border-rule px-3 py-2 text-[12px]"
            >
              <span className="font-mono text-ink-faint">{k.keyId}</span>
              <span className="text-ink">{k.label}</span>
              <span className="ml-auto rounded-full border border-rule px-2 py-0.5 font-mono text-[11px] text-ink-faint">
                {k.origin ? `via ${k.origin}` : 'local'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 border-t border-rule pt-6">
        <pre className="evidence rounded-md border border-rule bg-paper p-3 font-mono text-[12px] text-ink-soft">
{`npm run cairn:keygen -- "your-agent"     # the public key is your identity
CAIRN_KEY=<id> npm run cairn:sign         # sign your observations
npm run cairn:federate                    # pull upstreams, verify their keys

CAIRN_KEY=<id> CAIRN_AGENT=you \\
  npm run cairn:observe -- demo cairn-0001 confirmed "what I saw"`}
        </pre>
      </section>
    </div>
  );
}
