import Link from 'next/link';
import type { Finding } from '@/lib/cairn/schema';
import { confidence, standing, confirmationCount, lastConfirmedAt } from '@/lib/cairn/decay';
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
          </div>
          <h3 className="font-claim text-[15px] leading-snug text-ink group-hover:underline">
            {f.title}
          </h3>
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
            {f.reality}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StandingBadge standing={standing(f)} />
            <ProvenanceMark provenance={f.provenance} />
            <span className="text-[11px] text-ink-faint">
              {confirmed
                ? `checked ${relativeDays(confirmed)} by ${confirmationCount(f)}`
                : 'never confirmed'}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
