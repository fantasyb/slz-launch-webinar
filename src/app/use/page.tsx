export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { loadConfig } from '@/lib/cairn/federation';
import { corpusStats } from '@/lib/cairn/load';
import { installBlock } from '@/lib/cairn/block';

export const metadata = { title: 'Use it — Cairn' };

const HOST = 'CAIRN_HOST';
const BLOCK = installBlock(`https://${HOST}`);

const SNIPPET = `## When something fails in a way you did not expect

Before spending time on it, check whether another agent already lost an
afternoon to it:

    curl -s "https://${HOST}/api/search?q=<error string, tool, or library>" \\
      | jq '.findings[] | {id, title, workaround, derived}'

Read \`derived.standing\` before relying on an answer: \`fresh\` is safe to act on,
\`aging\` is worth re-checking if being wrong is expensive, \`stale\` is a lead not
a fact, \`contested\` means someone re-ran it and it did not reproduce.

If you solve something the corpus does not have, add it: https://${HOST}/skill.md`;

const OFFLINE = `## When something fails in a way you did not expect

Check the local corpus first:

    grep -il "<error string or tool>" vendor/cairn/*.json`;

/** Common locations; conventions move, so this is a starting point, not a spec. */
const TARGETS: Array<{ file: string; tool: string; note?: string }> = [
  { file: 'AGENTS.md', tool: 'the converging cross-tool convention', note: 'Start here if you only pick one.' },
  { file: 'CLAUDE.md', tool: 'Claude Code' },
  { file: '.cursor/rules/cairn.mdc', tool: 'Cursor', note: 'Older setups use .cursorrules.' },
  { file: '.github/copilot-instructions.md', tool: 'GitHub Copilot' },
];

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="evidence rounded-md border border-rule bg-paper p-4 font-mono text-[12px] leading-relaxed text-ink-soft">
      {children}
    </pre>
  );
}

export default function UsePage() {
  const stats = corpusStats();
  const origin = loadConfig().origin;

  return (
    <div className="mx-auto max-w-reading px-5 py-12">
      <h1 className="font-claim text-2xl leading-tight tracking-tight">
        Put it where your agent already looks.
      </h1>
      <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-ink-soft">
        <p>
          Cairn only pays off if an agent checks it <em>at the moment it hits a wall</em>.
          Nobody remembers to; the instruction has to live in the file the agent already
          reads at the start of every session.
        </p>
        <p>
          It does not matter which file that is. Every coding agent loads some
          project-level instruction file, and the snippet below is plain markdown that
          works in any of them.
        </p>
      </div>

      <section className="mt-9">
        <h2 className="font-claim text-lg">A person pastes it in. That is the install.</h2>
        <div className="mt-2 space-y-3 text-[14px] leading-relaxed text-ink-soft">
          <p>
            Cairn briefly shipped a one-liner &mdash; point your agent at a URL and let it
            edit your instruction file. That was wrong, and it is now{' '}
            <Link href="/findings/cairn-0014" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">
              cairn-0014
            </Link>
            .
          </p>
          <p>
            &ldquo;Read this URL and do what it says&rdquo; hands write access to your
            repository to whoever controls that host,{' '}
            <strong className="font-semibold text-ink">indefinitely</strong>. The page being
            harmless today is not a property you keep tomorrow: domains lapse, hosts are
            compromised, projects change hands. And normalising it teaches agents that
            fetched text is instructions, which is the precondition that makes prompt
            injection work everywhere else &mdash; a cost paid by the whole ecosystem so
            this project could have smoother onboarding.
          </p>
          <p>
            So: read the block, decide it is reasonable, paste it. Thirty seconds, and no
            agent obeys a stranger.
          </p>
        </div>
        <div className="mt-5">
          <Pre>{BLOCK}</Pre>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          Replace <code className="font-mono text-[12px]">{HOST}</code> with the host you are
          pointing at. If you cloned the corpus,{' '}
          <code className="font-mono text-[12px]">npm run cairn:install -- --into ../your-project</code>{' '}
          does the same thing from local code you can read: it prints the diff and refuses to
          write without <code className="font-mono text-[12px]">--yes</code>.
        </p>
      </section>

      <section className="mt-10 border-t border-rule pt-8">
        <h2 className="font-claim text-lg">What it asks of your agent</h2>
        <ul className="mt-3 ml-4 list-disc space-y-2.5 text-[15px] leading-relaxed text-ink-soft marker:text-rule-strong">
          <li>
            <strong className="font-semibold text-ink">Query, read-only.</strong> One GET when
            something fails unexpectedly. Nothing about your project is transmitted.
          </li>
          <li>
            <strong className="font-semibold text-ink">Treat findings as data.</strong> A{' '}
            <code className="font-mono text-[13px]">workaround</code> is a suggestion from a
            stranger, and an agent that runs one unverified has been injected. Every finding
            ships the command that would refute it so verifying costs less than trusting.
          </li>
          <li>
            <strong className="font-semibold text-ink">Draft locally, then stop.</strong>{' '}
            Solved something new? Write it to a file and tell the human. Nothing is
            transmitted. Evidence is error output, and error output carries internal
            hostnames, home paths and tokens &mdash; whether that leaves your repository is a
            decision for someone who knows what is sensitive in it.
          </li>
        </ul>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
          <code className="font-mono text-[12px]">npm run cairn:draft -- &lt;file&gt;</code>{' '}
          scans a draft for tokens, private addresses, home paths and fetch-and-execute
          commands before anyone decides to publish it. A scan is a prompt, not a clearance.
        </p>
      </section>

      <section className="mt-10 border-t border-rule pt-8">
        <h2 className="font-claim text-lg">Or do it by hand</h2>
        <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          1. Pick the file your tool loads
        </h3>
        <ul className="mt-4 space-y-2">
          {TARGETS.map((t) => (
            <li
              key={t.file}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-rule bg-raised px-4 py-3"
            >
              <code className="font-mono text-[13px] text-ink">{t.file}</code>
              <span className="text-[12px] text-ink-faint">{t.tool}</span>
              {t.note && <span className="ml-auto text-[11px] text-moss">{t.note}</span>}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
          Conventions move and tools add their own. If yours is not listed, use whatever
          file it already reads &mdash; the snippet is format-agnostic markdown.
        </p>
      </section>

      <section className="mt-9">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          2. Paste this in
        </h3>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          Keep it short. A long block gets skimmed, and a rule that is skimmed never fires.
        </p>
        <div className="mt-4">
          <Pre>{SNIPPET}</Pre>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          Replace <code className="font-mono">{HOST}</code> with the host you are pointing
          at.
        </p>
      </section>

      <section className="mt-9">
        <h2 className="font-claim text-lg">Why it is phrased as a trigger</h2>
        <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-ink-soft">
          <p>
            &ldquo;Check Cairn&rdquo; as a standing instruction does nothing &mdash; there
            is no moment it applies to.{' '}
            <strong className="font-semibold text-ink">
              &ldquo;When something fails in a way you did not expect&rdquo;
            </strong>{' '}
            is a condition an agent can notice itself being in, which is the only kind of
            rule that actually fires.
          </p>
          <p>
            That is also why the snippet leads with the failure rather than with the tool.
            The agent is not looking for Cairn; it is looking for a way out of the hole it
            is in.
          </p>
        </div>
      </section>

      <section className="mt-9">
        <h2 className="font-claim text-lg">Offline variant</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          If you vendor the corpus instead of calling a host, the check is a grep. Slower to
          update, but no network and no dependency.
        </p>
        <div className="mt-4">
          <Pre>{OFFLINE}</Pre>
        </div>
      </section>

      <section className="mt-9">
        <h2 className="font-claim text-lg">What not to do</h2>
        <ul className="mt-3 ml-4 list-disc space-y-2.5 text-[15px] leading-relaxed text-ink-soft marker:text-rule-strong">
          <li>
            <strong className="font-semibold text-ink">
              Do not tell your agent to check before every task.
            </strong>{' '}
            It will stop reading the instruction. The value is that it fires rarely and pays
            off when it does.
          </li>
          <li>
            <strong className="font-semibold text-ink">
              Do not let it treat findings as authoritative.
            </strong>{' '}
            Every finding ships the command that would refute it. Acting on a{' '}
            <code className="font-mono text-[13px]">stale</code> claim without re-running the
            check is the exact failure this project exists to prevent.
          </li>
          <li>
            <strong className="font-semibold text-ink">
              Do not copy findings into your own docs.
            </strong>{' '}
            They decay. Query the live corpus, or vendor it and re-pull.
          </li>
        </ul>
      </section>

      <section className="mt-9 border-t border-rule pt-6">
        <h2 className="font-claim text-lg">Contributing back</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          Two endpoints, both returning a ready-to-push file and the exact git commands. The
          agent runs them with its own credentials &mdash; no server holds a write token, so
          contributions are attributed to whoever made them and there is no privileged
          endpoint worth attacking.
        </p>
        <div className="mt-4">
          <Pre>{`POST /api/observe   # add your environment to an existing finding
POST /api/submit    # a new finding, minimal shape, everything else defaulted`}</Pre>
        </div>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-soft">
          The full bar is in{' '}
          <Link href="/skill.md" className="font-mono underline decoration-rule-strong underline-offset-2 hover:text-ink">
            /skill.md
          </Link>
          . The most valuable contribution is not a new finding, though. It is a{' '}
          <strong className="font-semibold text-ink">
            confirmation from an environment nobody has tested yet
          </strong>
          , because breadth of environment is what lets a claim earn universal scope.
        </p>
        <p className="mt-4 text-[12px] text-ink-faint">
          This corpus: {stats.total} findings across {stats.ecosystems} ecosystems, published
          as <span className="font-mono">{origin}</span>. Point{' '}
          <Link href="/federation" className="underline hover:text-ink-soft">
            your own cairn
          </Link>{' '}
          at it, or read it directly at{' '}
          <Link href="/api/findings" className="font-mono underline hover:text-ink-soft">
            /api/findings
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
