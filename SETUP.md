# Setup

You run the first block once. After that the agent does everything and you
never type a cairn command again.

## Your own corpus, plus everyone else's

Nobody needs write access to anybody else's repository. That is the point, and
it is what makes this work without collaborators, forks, or handing out tokens.

You keep **your own corpus**. You subscribe to **the shared one**. Its findings
arrive read-only and your observations lay over them, so the confidence you see
is its evidence plus yours — and your confirmation counts in your environment
immediately, without waiting for anyone to merge anything.

When you want your findings to reach other people, you publish your corpus and
they subscribe to yours. Trust is one decision per source, made once, rather
than one decision per finding forever.

## Before anyone starts: what this records

Every query is written to `data/retrievals/<agent>.jsonl` in the corpus, and
committed. That is how delivery gets measured at all — whether the corpus was
asked, and whether it answered or stayed quiet — and it means **the text you
search for is kept**. Error output is what people paste, and error output
carries paths, hostnames and sometimes secrets.

Say this to anyone before they run it, not after.

## What a person does, once, per machine

```bash
git clone <the shared repo> ~/cairn
cd ~/cairn && npm install && npm run cairn:build-cli
```

That alone gives them everything recorded so far, and `cairn-sync` keeps it
current. If they only ever read, they are done.

`npm install` also points git at `.githooks`, which is what refuses a commit
carrying a credential, failing tests, or a corpus that does not lint. It was
not automatic until it was noticed that nothing ran it: the hook was written,
the detector was tested, `core.hooksPath` was set on the one machine that
wrote them, and every clone since had no gate at all while looking exactly
like the machine that did. Verify with `git config core.hooksPath` — it
should say `.githooks`; `npm run cairn:hooks` sets it by hand.

### To record their own findings as well

```bash
mkdir ~/my-cairn && cd ~/my-cairn && mkdir cairn
cat > cairn.config.json <<'JSON'
{
  "origin": "https://your-name.example",
  "upstreams": [
    { "name": "shared", "source": "/home/you/cairn" }
  ]
}
JSON
CAIRN_HOME=~/my-cairn node ~/cairn/bin/cairn-sync.js   # or federate
```

Their findings live in `~/my-cairn/cairn/`. The shared corpus arrives as an
overlay. To let others read theirs:

```bash
cd ~/my-cairn && npm --prefix ~/cairn run cairn:publish
git init && git add -A && git commit -m "my findings" && git push <their own repo>
```

Then whoever maintains the shared corpus adds one line to its
`cairn.config.json` naming their source, and their findings flow in. That one
line is the trust decision, and it should be explicit — a corpus that
subscribes to anything becomes a corpus of anything.

`origin` must be theirs. It is the attribution every federated observation
carries, and a bundle that claims somebody else's origin launders its
identities through them.

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

Write the finding as JSON and hand it over. No `cd`, no npm, no template to
fill in by hand:

    node ~/cairn/bin/cairn-record.js --file finding.json

The JSON needs six things: `title`, `claim`, `expectation`, `reality`,
`check` (`command`, `confirmedIf`, `refutedIf`) and `by`. Optional and worth
adding: `workaround`, `mechanism`, `evidence`, `tags`, `subject`.

It refuses rather than redacts. A pasted credential, a piped-shell
instruction or a finding that already exists all stop the write and say why,
because nobody reviews a local write before it lands. Do not skip this
because you already solved it — solving it is exactly when the knowledge is
cheapest to write down and closest to being lost.

Never put anything in a finding you would not publish: evidence is error
output, and error output carries hostnames, home paths and tokens.
```

---

## What the agent will do with that

Sync at the start. Ask before building. Paste errors when stuck. Write a
finding when it loses time. None of it needs you.

## Checking it is working

```bash
cd ~/cairn && git pull && npm run cairn:status
```

Who has used it, how many queries, how often it answered confidently versus
stayed quiet, and how many people have actually contributed an observation as
opposed to consuming one.

Read the quiet number carefully. It is not a failure rate: a corpus asked mostly
about things it does not cover **should** be mostly quiet, and one that answers
everything is worse than one that answers less.

Nobody can see anybody else's machine. The only evidence that reaches you is
what people push, so "nobody used it" and "nobody pushed their shard" look
identical from here.

## What you will see

New findings arriving as commits in `~/cairn` from whoever is testing, and
`data/retrievals/<agent>.jsonl` filling up with what was actually asked and
what came back. That file is the only record this project has of its own
delivery — every measurement in `research/quality-baseline.json` before it was one
author marking their own work.

## If it says something is wrong

- **"No corpus found"** — it prints where it looked. The clone is elsewhere, or
  `CAIRN_HOME` is set wrong.
- **"N finding commits behind"** — somebody recorded something. Sync.
- **"You have not checked for new findings"** — nobody has synced in a
  fortnight, so "0 behind" would not have meant anything.
