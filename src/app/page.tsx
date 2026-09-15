export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { loadCorpus, corpusStats } from '@/lib/cairn/load';
import { surprise } from '@/lib/cairn/calibration';
import { FindingCard } from '@/components/FindingCard';

export default function Home() {
  const all = loadCorpus();
  const stats = corpusStats();

  /* A few real examples, the most surprising first — the ones a model did not
   * already know. Unscored findings fill the rest by recency so a new one still shows. */
  const byRecency = [...all].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const scored = all
    .map((f) => ({ f, s: surprise(f) }))
    .filter((x): x is { f: (typeof all)[number]; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.f);
  const featured = [...scored, ...byRecency.filter((f) => !scored.includes(f))].slice(0, 3);

  return (
    <div className="mx-auto max-w-5xl px-5">
      {/* What it is, in one breath */}
      <section className="border-b border-rule py-16 sm:py-20">
        <h1 className="font-claim max-w-reading text-3xl leading-tight tracking-tight sm:text-[38px]">
          Your agent keeps solving the same problems. Cairn remembers them so it doesn&rsquo;t.
        </h1>
        <div className="mt-5 max-w-reading space-y-4 text-[15px] leading-relaxed text-ink-soft">
          <p>
            A coding agent hits a trap &mdash; a tool that returns nothing instead of an error,
            a wrong default, an environment quirk &mdash; works it out, and then the session
            ends and it&rsquo;s gone. Tomorrow another agent pays for the same hour.
          </p>
          <p>
            Cairn is the memory it&rsquo;s missing. It records how your tools actually behave,
            keeps only what it can still <em>prove</em> is true on your machine, and hands the
            next agent the answer on the tool call that&rsquo;s about to fail. You install it
            once. After that it runs itself.
          </p>
        </div>

        <div className="mt-8 max-w-reading">
          <pre className="evidence overflow-x-auto rounded-md border border-rule bg-paper p-4 font-mono text-[13px] leading-relaxed text-ink-soft">
{`npm run cairn:install -- --home ~/pilot`}
          </pre>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
            Then restart your agent. That&rsquo;s the whole setup &mdash; no keys to make, no
            files to edit, nothing to run again.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/findings"
            className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-opacity hover:opacity-85"
          >
            See what it remembers
          </Link>
          <Link
            href="/use"
            className="rounded-md border border-rule-strong px-4 py-2 text-[13px] transition-colors hover:border-ink-faint"
          >
            How it works
          </Link>
        </div>
      </section>

      {/* Three steps, because that is the whole of it */}
      <section className="border-b border-rule py-12">
        <h2 className="font-claim text-lg">Install once, then forget about it</h2>
        <ol className="mt-6 grid gap-5 sm:grid-cols-3">
          {[
            {
              n: '1',
              h: 'Install it',
              b: 'One command puts it in every session and gives this machine its own identity. Restart, and you’re done.',
            },
            {
              n: '2',
              h: 'It learns while you work',
              b: 'When your agent hits and solves a real trap, Cairn saves it in the background. Nothing to do, nothing to remember.',
            },
            {
              n: '3',
              h: 'It’s there the instant it matters',
              b: 'The moment your agent reaches for a tool a trap is recorded about — same session, any project — the answer rides in on that call.',
            },
          ].map((step) => (
            <li key={step.n}>
              <div className="font-claim text-[13px] text-moss">{step.n}</div>
              <div className="mt-1 text-[14px] font-semibold text-ink">{step.h}</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{step.b}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* The differentiator: verification, not just storage */}
      <section className="border-b border-rule py-12">
        <h2 className="font-claim text-lg">It only remembers what it can prove</h2>
        <div className="mt-4 max-w-reading space-y-4 text-[14px] leading-relaxed text-ink-soft">
          <p>
            A note in a doc rots silently. &ldquo;This tool caps at 50 rows&rdquo; is true when
            written and false a month later, and the sentence looks identical either way. A
            person catches the stale date; an agent ingests it as fact.
          </p>
          <p>
            So a Cairn finding is not prose. It carries a command that <em>proves the trap is
            still live</em> &mdash; run once with the trap present and once with it removed, on a
            single machine, and kept only if the two come out different. A claim that can&rsquo;t
            say what would falsify it never gets in. And every finding decays on a clock:
            confidence halves over its half-life unless someone re-runs the check, so a warning
            that has quietly stopped being true is retired instead of steering the next agent wrong.
          </p>
        </div>
        <Link href="/about" className="mt-4 inline-block text-[13px] text-ink-soft hover:text-ink">
          Why prose rots and a check doesn&rsquo;t &rarr;
        </Link>
      </section>

      {/* How delivery actually works now: the gateway at the tool-call chokepoint */}
      <section className="border-b border-rule py-12">
        <h2 className="font-claim text-lg">Delivered on the call that&rsquo;s about to fail</h2>
        <div className="mt-4 max-w-reading space-y-4 text-[14px] leading-relaxed text-ink-soft">
          <p>
            Cairn sits between your agent and the tools it calls &mdash; every MCP server, one
            gateway in front. It reads nothing you don&rsquo;t already send and changes no result.
            It adds one thing: when your agent reaches for a tool a trap is recorded about, the
            warning rides in on that exact call, in whatever client you use, with no feature to
            switch on.
          </p>
          <p>
            That is the whole difference between memory that helps and memory that sits unread.
            The answer arrives at the one moment it can change what the agent does next &mdash;
            not in a doc it won&rsquo;t open, not next session, but on the tool call itself.
          </p>
        </div>
      </section>

      {/* Concrete examples — the argument made with instances, not adjectives */}
      <section className="border-b border-rule py-12">
        <div className="mb-2 flex items-baseline justify-between gap-4">
          <h2 className="font-claim text-lg">Real things it has caught</h2>
          <Link href="/findings" className="text-[13px] text-ink-soft hover:text-ink">
            all {stats.total} &rarr;
          </Link>
        </div>
        <p className="mb-5 max-w-reading text-[14px] leading-relaxed text-ink-soft">
          Each one cost somebody real time to figure out the first time. Each carries the exact
          command that proves it&rsquo;s still true &mdash; so it can be re-checked, and quietly
          retired when the software changes underneath it.
        </p>
        <div className="grid gap-3">
          {featured.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      </section>

      {/* Where the knowledge lives — the trust model, said plainly */}
      <section className="py-12">
        <h2 className="font-claim text-lg">Your knowledge stays yours</h2>
        <p className="mt-2 max-w-reading text-[14px] leading-relaxed text-ink-soft">
          Cairn keeps what it learns in two places, and both belong to you.
        </p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <div>
            <div className="text-[14px] font-semibold text-ink">On your machine</div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
              Traps about your tools and environment live on your computer and follow you across
              every project you work in.
            </p>
          </div>
          <div>
            <div className="text-[14px] font-semibold text-ink">In your repos</div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
              Traps about a specific codebase live in that repo and travel with it &mdash; commit
              them, and your teammates get them too, reviewed like any other change.
            </p>
          </div>
        </div>
        <p className="mt-6 max-w-reading text-[13px] leading-relaxed text-ink-soft">
          It is never a shared public database. Nothing leaves your machine unless you commit it
          to a repo you already trust &mdash; so the only people who ever see a finding are the
          people you already share code with.
        </p>
      </section>
    </div>
  );
}
