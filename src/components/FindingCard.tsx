import Link from 'next/link';
import type { Finding } from '@/lib/cairn/schema';
import {
  confidence,
  standing,
  confirmationCount,
  lastConfirmedAt,
  environmentCount,
} from '@/lib/cairn/decay';
import { ConfidenceStack, StandingBadge, ProvenanceMark } from './Standing';
import { relativeDays, cn } from '@/lib/utils';

const KIND_LABEL: Record<Finding['kind'], string> = {
  trap: 'trap',
  limitation: 'limitation',
  'dead-end': 'dead end',
  correction: 'correction',
};

export function FindingCard({ finding: f }: { finding: Finding }) {
  const c = confidence(f);
  const confirmed = lastConfirmedAt(f);
  return (
    <Link
      href={`/findings/${f.id}`}
      className={cn(
        'group block rounded-lg border border-rule bg-raised p-5 shadow-stone transition-colors hover:border-rule-strong',
        f.status === 'retired' && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-4">
        <ConfidenceStack value={c} className="mt-1.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-faint">
            <span className="font-mono">{f.id}</span>
            <span className="text-rule-strong">·</span>
            <span>{KIND_LABEL[f.kind]}</span>
            <span className="text-rule-strong">·</span>
            <span className="font-mono">{f.subject.name}</span>
            <span className="text-rule-strong">·</span>
            <span
              title={
                f.scope === 'universal'
                  ? 'Asserted to hold everywhere. Discounted until confirmed across environments.'
                  : f.appliesTo
              }
              className={f.scope === 'universal' ? 'text-moss' : 'text-slate'}
            >
              {f.scope === 'universal' ? 'universal' : 'env-specific'}
            </span>
            {f.basis === 'structural' && (
              <>
                <span className="text-rule-strong">·</span>
                <span
                  title="Follows from how the thing is built, not from observing it. Breadth of environment is not owed."
                  className="text-slate"
                >
                  structural
                </span>
              </>
            )}
          </div>
          <h3 className="font-claim break-words text-[15px] leading-snug text-ink group-hover:underline">
            {f.title}
          </h3>
          <p className="mt-2 line-clamp-2 break-words text-[13px] leading-relaxed text-ink-soft">
            {f.reality}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StandingBadge standing={standing(f)} />
            <ProvenanceMark provenance={f.provenance} />
            {/* The date and the count answer different questions, so they are
                no longer joined by "by". lastConfirmedAt takes any confirmed
                observation; confirmationCount counts only parties identified by
                a signature, so a finding confirmed three days ago by an
                unsigned observer read "checked 3 days ago by 0". */}
            <span className="text-[11px] text-ink-faint">
              {confirmed ? `checked ${relativeDays(confirmed)}` : 'never confirmed'}
            </span>
            <span
              title="Distinct signed confirmers. An unsigned confirmation is attributable to nobody, so it still sets the date above but adds nothing here."
              className="text-[11px] text-ink-faint"
            >
              {confirmationCount(f)} signed
            </span>
            <span
              title="Distinct environments in which this was confirmed."
              className="text-[11px] text-ink-faint"
            >
              {environmentCount(f)} env
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
