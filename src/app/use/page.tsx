export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { loadConfig } from '@/lib/cairn/federation';
import { corpusStats } from '@/lib/cairn/load';
import { installBlock } from '@/lib/cairn/block';

export const metadata = { title: 'Use it — Cairn' };

// Falls back to the placeholder only when no canonical origin is configured,
// which is also exactly when the served install block is refused a signature.
const HOST = process.env.CAIRN_BASE_URL?.replace(/^https?:\/\//, '') ?? 'CAIRN_HOST';
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
        <h2 className="font-claim text-lg">One command, and safe. Both.</h2>
        <div className="mt-2 space-y-3 text-[14px] leading-relaxed text-ink-soft">
          <p>
            Cairn briefly shipped &ldquo;point your agent at this URL and let it follow the
            page.&rdquo; That was wrong &mdash;{' '}
            <Link href="/findings/cairn-0014" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">
              cairn-0014
            </Link>{' '}
            &mdash; but the fix is not <em>never fetch</em>. The danger was{' '}
            <strong className="font-semibold text-ink">obeying</strong>, not fetching.
          </p>
          <p>
            &ldquo;Read this URL and do what it says&rdquo; authorises a <em>location</em>,
            and whoever controls it later. Pinning a key authorises specific{' '}
            <em>content</em>. So the block is served signed, you pin a key obtained out of
            band, and a swapped or compromised host fails closed instead of executing. Same
            trust model as any pinned dependency &mdash; not a novel risk.
          </p>
        </div>
        <div className="mt-4">
          <Pre>{`# fetched and automatic — verified against a key you pin
npm run cairn:install -- --into ../your-project \\
  --from https://${HOST}/api/block --key <keyId> --yes

# or entirely local, from code you can read
npm run cairn:install -- --into ../your-project --base https://${HOST}`}</Pre>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          A stolen key still signs perfectly, so the content is checked independently:
          nothing executable, no host but the one you are adopting. Verified against a hostile
          server &mdash; a tampered block fails the signature, and a{' '}
          <em>correctly signed</em> hostile block is still refused by the shape check. Two
          gates, each catching what the other misses.
        </p>
        <h3 className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Or paste it by hand
        </h3>
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
            hostnames, home paths and tokens.
          </li>
        </ul>
        <h3 className="mt-7 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Secrets are stripped, not flagged
        </h3>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          A flow that hands a contributor eight warnings per draft is one they use once. So
          redaction is automatic and fails closed.
        </p>
        <div className="mt-3">
          <Pre>{`npm run cairn:hooks                    # enable the pre-commit gate, once
npm run cairn:draft -- <file> --fix    # strip credentials, hosts, paths, blobs in place`}</Pre>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">
          The hook refuses to let a secret enter git history at all, and refuses corpus
          findings carrying fetch-and-execute or credential reads. It costs nothing until it
          fires. What redaction cannot catch is semantic &mdash; a stack frame quoting
          proprietary source, a directory naming a customer &mdash; so that stays a glance,
          not an audit.
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
        <h2 className="font-claim text-lg">Knowing in advance which traps are yours</h2>
        <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-ink-soft">
          <p>
            Most of this corpus is{' '}
            <code className="font-mono text-[13px]">environment-specific</code>, which
            means most of it is not about your machine. A finding about an allowlist proxy
            is noise on a laptop with open egress, and the title alone does not say which
            you are.
          </p>
          <p>
            So findings carry a <strong className="font-semibold text-ink">precondition</strong>{' '}
            &mdash; a machine-checkable statement of when the claim applies:
          </p>
        </div>
        <div className="mt-4">
          <Pre>{`"precondition": ["env:HTTPS_PROXY", "no-cmd:dig"]

npm run cairn:match     # ranks the corpus by which preconditions hold here`}</Pre>
        </div>
        <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-ink-soft">
          <p>
            Four kinds, all read-only:{' '}
            <code className="font-mono text-[12px]">env:NAME</code>,{' '}
            <code className="font-mono text-[12px]">cmd:</code> /{' '}
            <code className="font-mono text-[12px]">no-cmd:</code>,{' '}
            <code className="font-mono text-[12px]">path:</code>,{' '}
            <code className="font-mono text-[12px]">os:</code>. Deliberately{' '}
            <em>not</em> shell. A precondition has to run automatically to be worth
            anything, and a stranger&rsquo;s shell string running unread is{' '}
            <Link href="/findings/cairn-0014" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">
              cairn-0014
            </Link>{' '}
            with extra steps. An unknown predicate kind evaluates false rather than
            being skipped.
          </p>
          <p>
            This changes when the corpus is useful. The trigger snippet fires{' '}
            <em>after</em> something has already gone wrong.{' '}
            <code className="font-mono text-[12px]">cairn:match</code>, run once against a
            new sandbox or CI image, says which traps you are standing in before you step
            in one. Nothing is transmitted &mdash; the predicates are evaluated locally
            against a corpus you already have.
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
