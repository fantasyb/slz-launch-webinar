export const dynamic = 'force-dynamic';

import Link from 'next/link';

export const metadata = { title: 'How it works — Cairn' };

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="evidence overflow-x-auto rounded-md border border-rule bg-paper p-4 font-mono text-[12px] leading-relaxed text-ink-soft">
      {children}
    </pre>
  );
}

export default function UsePage() {
  return (
    <div className="mx-auto max-w-reading px-5 py-12">
      <h1 className="font-claim text-2xl leading-tight tracking-tight">Install it once. It runs itself.</h1>
      <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-ink-soft">
        <p>
          There is one thing you do, and you do it once. Everything after that happens on its
          own, in the background, while you work.
        </p>
      </div>

      {/* The one command */}
      <section className="mt-10">
        <h2 className="font-claim text-lg">1. Install</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          From the Cairn checkout, one command:
        </p>
        <div className="mt-4">
          <Pre>{`npm run cairn:install -- --home ~/pilot`}</Pre>
        </div>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">Then restart your agent. That command:</p>
        <ul className="mt-3 space-y-1.5 text-[14px] leading-relaxed text-ink-soft">
          <li>&bull; adds Cairn to every session, in every project &mdash; not just one</li>
          <li>&bull; gives this machine its own signing identity, so what it records is countably its own</li>
          <li>&bull; wires up the background work below</li>
        </ul>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-faint">
          No key to make, no config file to edit, nothing to run again. Add{' '}
          <code className="font-mono text-[12px]">--dry-run</code> first to see every change and write
          nothing; undo any time with <code className="font-mono text-[12px]">--uninstall</code>.
        </p>
      </section>

      {/* What happens on its own */}
      <section className="mt-12">
        <h2 className="font-claim text-lg">2. It learns while you work</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          You never stop to &ldquo;save&rdquo; anything. When a session ends, Cairn reads back
          what happened and notices the moments your agent was surprised &mdash; where it
          expected one thing and a tool did another. Those are the traps worth keeping.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
          Before any of them becomes a finding, it has to earn it: the trap is reproduced on
          your machine, and a finding is kept only if there is a concrete command that behaves
          one way when the trap is present and another when it is not. Anything that can&rsquo;t
          be shown to be real is dropped. Nothing enters the record on a hunch.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="font-claim text-lg">3. It&rsquo;s there the next time</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          The next session &mdash; in any project on that machine &mdash; gets the answer at the
          moment it&rsquo;s about to hit the same wall, delivered right where the agent is
          working. It doesn&rsquo;t have to think to go look; the warning is already there.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
          And because every finding carries the command that proves it, an answer that has gone
          out of date &mdash; the tool changed, the bug was fixed &mdash; quietly loses trust
          instead of misleading anyone.
        </p>
      </section>

      {/* Where it lives */}
      <section className="mt-12">
        <h2 className="font-claim text-lg">Where the knowledge lives</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">Two places, both yours:</p>
        <div className="mt-4 space-y-4">
          <div>
            <div className="text-[14px] font-semibold text-ink">Your machine</div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              Traps about your tools and environment &mdash; the ones that are true no matter
              which project you&rsquo;re in &mdash; live on your computer and follow you everywhere.
            </p>
          </div>
          <div>
            <div className="text-[14px] font-semibold text-ink">Your repos</div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              Traps about one codebase live in that repo, in a <code className="font-mono text-[12px]">.cairn</code>{' '}
              folder. Run <code className="font-mono text-[12px]">npm run cairn:project</code> inside it, commit
              the folder, and your teammates get that knowledge too &mdash; reviewed like any
              other change. When you&rsquo;re working in the repo, Cairn reads both at once.
            </p>
          </div>
        </div>
      </section>

      {/* The reassurance */}
      <section className="mt-12 rounded-lg border border-rule bg-raised p-5">
        <h2 className="font-claim text-[15px]">What it will never do</h2>
        <ul className="mt-3 space-y-1.5 text-[13px] leading-relaxed text-ink-soft">
          <li>&bull; It does not send your code, your prompts, or your project anywhere.</li>
          <li>&bull; It is not a shared public database. Nothing leaves your machine unless you commit it to a repo you already trust.</li>
          <li>
            &bull; It does not run commands from strangers. It only ever verifies traps on your own
            machine, and only when you&rsquo;ve turned that on.
          </li>
        </ul>
      </section>

      <section className="mt-12 border-t border-rule pt-8">
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Curious what it actually stores?{' '}
          <Link href="/findings" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">
            Read the corpus
          </Link>
          . Building an agent that should speak this?{' '}
          <Link href="/skill.md" className="font-mono underline decoration-rule-strong underline-offset-2 hover:text-ink">
            skill.md
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
