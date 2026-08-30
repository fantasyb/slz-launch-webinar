import Link from 'next/link';
import { loadCorpus, search, byConfidence } from '@/lib/cairn/load';
import { FindingCard } from '@/components/FindingCard';
import { standing } from '@/lib/cairn/decay';
import { cn } from '@/lib/utils';

const FILTERS = ['all', 'fresh', 'aging', 'stale', 'contested', 'retired'] as const;

export const metadata = { title: 'Findings — Cairn' };

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; standing?: string }>;
}) {
  const { q = '', standing: filter = 'all' } = await searchParams;

  let results = q ? search(q) : byConfidence(loadCorpus());
  if (filter !== 'all') results = results.filter((f) => standing(f) === filter);

  return (
    <div className="mx-auto max-w-5xl px-5 py-12">
      <h1 className="font-claim text-xl">Findings</h1>
      <p className="mt-2 max-w-reading text-[14px] leading-relaxed text-ink-soft">
        Sorted by confidence: freshly confirmed claims first, eroding ones below,
        tombstones last.
      </p>

      <form method="get" className="mt-6 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search claims, subjects, tags…"
          className="w-full max-w-sm rounded-md border border-rule bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
        />
        {filter !== 'all' && <input type="hidden" name="standing" value={filter} />}
        <button
          type="submit"
          className="rounded-md border border-rule-strong px-3 py-2 text-[13px] transition-colors hover:border-ink-faint"
        >
          Search
        </button>
      </form>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {FILTERS.map((s) => {
          const params = new URLSearchParams();
          if (q) params.set('q', q);
          if (s !== 'all') params.set('standing', s);
          const href = `/findings${params.toString() ? `?${params}` : ''}`;
          return (
            <Link
              key={s}
              href={href}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                filter === s
                  ? 'border-ink bg-ink text-paper'
                  : 'border-rule text-ink-soft hover:border-rule-strong',
              )}
            >
              {s}
            </Link>
          );
        })}
      </div>

      <p className="mt-6 text-[12px] text-ink-faint">
        {results.length} {results.length === 1 ? 'finding' : 'findings'}
        {q && <> matching &ldquo;{q}&rdquo;</>}
      </p>

      <div className="mt-3 grid gap-3">
        {results.map((f) => (
          <FindingCard key={f.id} finding={f} />
        ))}
        {results.length === 0 && (
          <p className="rounded-lg border border-dashed border-rule-strong p-8 text-center text-[13px] text-ink-faint">
            Nothing here yet. A gap in the corpus is itself information &mdash; if you
            hit this dead end, record it.
          </p>
        )}
      </div>
    </div>
  );
}
