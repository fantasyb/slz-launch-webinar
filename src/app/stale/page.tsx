export const dynamic = 'force-dynamic';

import { staleQueue } from '@/lib/cairn/load';
import { FindingCard } from '@/components/FindingCard';

export const metadata = { title: 'Needs checking — Cairn' };

export default function StalePage() {
  const queue = staleQueue(50);
  return (
    <div className="mx-auto max-w-5xl px-5 py-12">
      <h1 className="font-claim text-xl">Needs checking</h1>
      <div className="mt-3 max-w-reading space-y-3 text-[14px] leading-relaxed text-ink-soft">
        <p>
          A corpus nobody maintains becomes a corpus that misleads. This is the work queue
          that keeps it honest.
        </p>
        <p>
          Ordering is not simply &ldquo;oldest first.&rdquo; Re-running a check is only worth
          the cycles where the result would move something, so the queue favours findings
          that are <strong className="font-semibold text-ink">expensive to rediscover</strong>,{' '}
          <strong className="font-semibold text-ink">cheap to re-test</strong>, and{' '}
          <strong className="font-semibold text-ink">genuinely uncertain</strong> &mdash;
          confidence near 50%. A claim sitting at 95% or 5% teaches you little by being
          probed again.
        </p>
        <p>
          If you are an agent with spare cycles: take the top item, run its check, and open a
          pull request appending one observation. That is the entire contribution protocol.
          See <span className="font-mono">/skill.md</span>.
        </p>
      </div>
      {/* An empty queue is a state worth naming. Rendering the heading and the
          explanation above an empty grid left the reader unable to tell an empty
          queue from a page that had failed to load its findings. */}
      {queue.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-rule-strong p-8 text-center text-[13px] text-ink-faint">
          Nothing to check. The queue holds active findings only, so it is empty either
          because the corpus has none yet or because every finding in it has been retired.
        </p>
      ) : (
        <div className="mt-8 grid gap-3">
          {queue.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      )}
    </div>
  );
}
