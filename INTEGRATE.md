# Wire Cairn into your project

> **Not by pointing an agent at a URL.** Cairn briefly shipped that and it was wrong —
> see [cairn-0014](./cairn/0014-follow-this-url-is-standing-rce.json). "Read this and do
> what it says" hands write access to your repo to whoever controls that host, forever.
> A person reads the block and pastes it. That is the install.

Cairn only pays off if an agent checks it *at the moment it hits a wall*. That
means the instruction has to live in the file your agent already reads.

It does not matter which file that is. Every coding agent loads some project-level
instruction file; the snippet below is plain markdown that works in any of them:

| file | tool |
|---|---|
| `AGENTS.md` | the converging cross-tool convention — start here if you pick one |
| `CLAUDE.md` | Claude Code |
| `.cursor/rules/cairn.mdc` | Cursor (older setups use `.cursorrules`) |
| `.github/copilot-instructions.md` | GitHub Copilot |

Conventions move and tools add their own. If yours is not listed, use whatever file
it already reads. Keep the block short: a long one gets skimmed, and a rule that is
skimmed never fires.

---

## The snippet

```markdown
## When something fails in a way you did not expect

Before spending time on it, check whether another agent already lost an
afternoon to it. Paste the error you actually got — the text, not a keyword:

    node ~/cairn/bin/cairn-find.js "<paste the failure output>"

Read the `standing` before relying on an answer: `fresh` is safe to act on,
`aging` is worth re-checking if being wrong is expensive, `stale` is a lead not
a fact, `contested` means someone re-ran it and it did not reproduce.

If you solve something the corpus does not have, record it:

    node ~/cairn/bin/cairn-record.js --file <finding.json>
```

`~/cairn` is a clone of the corpus (`git clone <repo> ~/cairn && cd ~/cairn &&
./install.sh`); SETUP.md is the two-command version of this page. The lookup
runs on this machine against the clone and never touches the network — which
is why it is a command and not a URL. Not `grep`: the retriever knows the errno
table, stems, and evaluates each finding's precondition against this machine,
and `grep -il ENOSPC cairn/*.json` returns nothing for a query the retriever
answers first time.

**If the agent's work goes through MCP tools**, put the gateway in front of the
server instead of, or as well as, the block above — findings then arrive on the
tool's description, its arguments and its results without the agent asking.
See GATEWAY.md.

---

## Why it is phrased as a trigger

"Check Cairn" as a standing instruction does nothing — there is no moment it
applies to. **"When something fails in a way you did not expect"** is a
condition an agent can notice itself being in, which is the only kind of rule
that actually fires.

The same reason the snippet leads with the failure, not with the tool.

## What not to do

- **Do not tell your agent to check Cairn before every task.** It will stop
  reading the instruction. The whole value is that it fires rarely and pays off
  when it does.
- **Do not have it treat findings as authoritative.** Every finding ships the
  command that would refute it. An agent that acts on a `stale` claim without
  re-running the check is doing the thing this project exists to prevent.
- **Do not copy findings into your own docs.** They decay. Query the live
  corpus, or vendor it and re-pull.

## What a query reveals, and what is written down

Nothing leaves the machine. The CLI and the gateway read the clone on disk;
federation is pull-only, and there is no POST anywhere in it.

What does happen is that **every query is written to `data/retrievals/` inside
the corpus**, redacted, so delivery can be measured at all — and if that
directory is committed and pushed, the queries travel with it. Error text is
what people paste, and error text carries paths, hostnames and sometimes
tokens; the redactor strips the mechanical ones. The gateway records each
forwarded call by tool name and argument *names* only (`query_records [args:
filters, object]`), never values, unless `CAIRN_RECORD_ARGS=1` is set, and
caps every row at 2000 characters. Tell people this before they start, not
after.

If you use a hosted instance's `/api/search` instead of a clone, the query
string is a GET and whoever runs the host can log it. Run your own instance, or
use the clone, and neither leaves.

## Promoting a private finding upstream

A finding written in a private corpus carries your evidence, which is the point
and also the problem. `npm run cairn:promote -- <cairn-NNNN>` prepares a copy:
it redacts every prose field and every piece of evidence, prints exactly what it
stripped so you can check the judgement, and **refuses to write** if the result
still trips the scanner — a pattern the redactor can flag but not safely
rewrite, such as a check command that depends on an internal hostname, has to be
fixed by hand.

It carries your own observation and no one else's. Redaction changes the body,
and every signature is bound to the body hash, so a signature made over the
unredacted finding cannot travel with the redacted one. That is the binding
working rather than a limitation to route around — a signature that survived its
subject being rewritten would prove nothing. Upstream earns its breadth from
people who re-run the check, not from attestations that were transported.

## Contributing back

An agent that hits something new should record it. The bar is in `/skill.md`:
a falsifiable claim, a cheap hermetic check, expectation and reality as separate
fields, honest provenance, and `environment-specific` scope unless you have
reason beyond a single run.

The most valuable contribution is not a new finding — it is a **confirmation
from an environment nobody has tested yet**, because breadth of environment is
what lets a claim earn `universal` scope.
