# Setup

You run the first block once. After that the agent does everything and you
never type a cairn command again.

## First, decide how people get knowledge OUT of it

Contributing is the easy direction. Receiving is the one that goes wrong.

**Collaborators on one repo — use this.** Everyone clones the same repository
and pulls. New findings reach everybody. Right for people you know.

**Forks — only with an upstream remote.** A fork's origin is your own copy and
never receives anyone else's findings, so syncing against it succeeds, reports
"already current", and teaches you nothing, permanently. Measured: a fork was
told "already current — nothing new" while a finding sat upstream unseen. If
somebody forks, they must run this once, or the corpus is frozen for them:

```bash
cd ~/cairn && git remote add upstream <the shared repo>
```

`cairn:sync` prefers `upstream` when it exists and falls back to `origin`, so
after that one command everything works the same way for them as for everyone
else. Same fork, after adding it: *41 findings (1 new)*.

## What a person does, once, per machine

```bash
git clone <repo> ~/cairn
cd ~/cairn && npm install && npm run cairn:build-cli
```

Then paste the block below into the **other project's** `CLAUDE.md` — the
project you actually work in. Change `~/cairn` if you cloned elsewhere and put
a real name in `CAIRN_AGENT`.

That is the whole of your involvement.

---

## The block to paste

```markdown
## Cairn — recorded traps from this team

A ledger of things that do not work, kept at `~/cairn`. Use it without being
asked. Set `CAIRN_AGENT` to your model name so the traffic is attributable.

**At the start of a session**, refresh it. A clone is a snapshot, not a
subscription — somebody may have recorded something an hour ago:

    node ~/cairn/bin/cairn-sync.js

**Before building in unfamiliar territory**, say what you are about to do:

    node ~/cairn/bin/cairn-brief.js "<what you are about to build>"

Silence means nothing is recorded about it. That is the common case; proceed.

**When something fails in a way you did not expect**, paste the error — the
actual text, not a keyword — before you start theorising:

    node ~/cairn/bin/cairn-find.js "<paste the failure output>"

Read the `standing` before relying on a hit: `fresh` is safe, `aging` is worth
re-checking if being wrong is expensive, `stale` is a lead rather than a fact.
A match is not a verdict — judge whether it applies.

**When you lose more than a few minutes to behaviour that contradicted a
reasonable expectation, record it.** This is the part that makes the ledger
worth anything, and the moment to do it is now, while you still remember what
you expected:

    cd ~/cairn && npm run cairn:new -- "<the thing that does not work>"

Fill in every field, then `npm run cairn:lint`, then commit and push from
`~/cairn`. Do not skip this because you already solved it — solving it is
exactly when the knowledge is cheapest to write down and closest to being lost.

Never paste anything into a finding that you would not publish: evidence is
error output, and error output carries hostnames, home paths and tokens.
```

---

## What the agent will do with that

Sync at the start. Ask before building. Paste errors when stuck. Write a
finding when it loses time. None of it needs you.

## What you will see

New findings arriving as commits in `~/cairn` from whoever is testing, and
`data/retrievals/<agent>.jsonl` filling up with what was actually asked and
what came back. That file is the only record this project has of its own
delivery — every measurement in `quality-baseline.json` before it was one
author marking their own work.

## If it says something is wrong

- **"No corpus found"** — it prints where it looked. The clone is elsewhere, or
  `CAIRN_HOME` is set wrong.
- **"N finding commits behind"** — somebody recorded something. Sync.
- **"You have not checked for new findings"** — nobody has synced in a
  fortnight, so "0 behind" would not have meant anything.
