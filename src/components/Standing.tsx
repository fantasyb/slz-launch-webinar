import { cn } from '@/lib/utils';
import type { Standing } from '@/lib/cairn/decay';
import type { Provenance } from '@/lib/cairn/schema';

const STANDING_STYLE: Record<Standing, { label: string; className: string; hint: string }> = {
  fresh: {
    label: 'fresh',
    className: 'bg-moss-soft text-moss border-moss/25',
    hint: 'Recently confirmed. Safe to rely on.',
  },
  aging: {
    label: 'aging',
    className: 'bg-ochre-soft text-ochre border-ochre/25',
    hint: 'Confidence is decaying. Worth re-checking before you depend on it.',
  },
  stale: {
    label: 'stale',
    className: 'bg-rust-soft text-rust border-rust/25',
    hint: 'Long unverified. Treat as a lead, not a fact.',
  },
  contested: {
    label: 'contested',
    className: 'bg-rust-soft text-rust border-rust/40',
    hint: 'Someone re-ran the check and it did not reproduce.',
  },
  retired: {
    label: 'retired',
    className: 'bg-slate-soft text-slate border-slate/25',
    hint: 'No longer holds. Kept for the record.',
  },
};

export function StandingBadge({ standing, className }: { standing: Standing; className?: string }) {
  const s = STANDING_STYLE[standing];
  return (
    <span
      title={s.hint}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide',
        s.className,
        className,
      )}
    >
      {s.label}
    </span>
  );
}

export function standingHint(standing: Standing) {
  return STANDING_STYLE[standing].hint;
}

/**
 * Confidence drawn as a stack of stones. Five slots; each filled stone is
 * 20% confidence. Deliberately coarse — the underlying number is an
 * estimate and a precise-looking bar would oversell it.
 */
export function ConfidenceStack({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const filled = Math.round(value * 5);
  return (
    <span
      className={cn('inline-flex flex-col-reverse gap-[2px]', className)}
      aria-label={`confidence ${Math.round(value * 100)} percent`}
      role="img"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            'block rounded-[1px] transition-colors',
            // Stones taper as they go up, like a real cairn.
            i === 0 && 'h-[3px] w-[18px]',
            i === 1 && 'h-[3px] w-[15px]',
            i === 2 && 'h-[3px] w-[12px]',
            i === 3 && 'h-[3px] w-[9px]',
            i === 4 && 'h-[3px] w-[6px]',
            i < filled ? 'bg-moss' : 'bg-rule-strong',
          )}
        />
      ))}
    </span>
  );
}

export function ProvenanceMark({ provenance }: { provenance: Provenance }) {
  const firsthand = provenance === 'firsthand';
  return (
    <span
      title={
        firsthand
          ? 'The author executed the repro and observed the failure.'
          : 'Asserted from prior knowledge. Not re-executed by the author.'
      }
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium',
        firsthand ? 'text-moss' : 'text-ink-faint',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          firsthand ? 'bg-moss' : 'border border-ink-faint bg-transparent',
        )}
      />
      {provenance}
    </span>
  );
}
