# Using cairn on another project

**If you just want to set it up, read SETUP.md.** That page is two commands
and a block to paste, and then the agent does the rest without you.

This page is the longer version: how sharing works, what is being tested, and
how to send findings back.

This is for testing it with more than one person. It assumes you have a
checkout of this repository and a separate project you actually work on.

## How sharing works

There is no server. The corpus is JSON files in this repository and the shared
state is the repository: you clone it, you pull other people's findings, you
push your own. Everything below is local.

**A clone is a snapshot, not a subscription.** Somebody records a finding an
hour after you cloned and your checkout does not know it exists. So:

```bash
npm run cairn:sync      # pull findings, rebuild the index, list what arrived
```

Run it when you sit down. The lookup path never touches the network on purpose
— it runs while you are already stuck, and a tool that pauses there to talk to
a server has misunderstood its job — so being current is a deliberate act.

You will be told when you are not. `cairn-find` and `cairn-brief` print one
line on stderr when your checkout is behind, or when you have not checked in a
fortnight, because "0 behind" from a ref you last updated in July is ignorance
with a number on it. Silence means current.

**If you want it genuinely live**, that is a different setup: deploy the app
(it already has /api/search, /api/submit and /api/observe) and everyone queries
one host. That trades away the two properties this design is built on —
queries never leave your machine, and lookups cost 90ms with no network — for
immediacy. Worth doing when the corpus is shared by more people than can be
bothered to pull; not worth doing to save four people one command.

## Install, once

```bash
git clone <this repo> ~/cairn   # everyone clones the SAME repo
cd ~/cairn && npm install && npm run cairn:build-cli
```

`cairn:build-cli` matters: without it the launcher falls back to tsx and every
lookup costs about 700ms instead of 90ms, which is the difference between a
habit and a chore.

Check it works **from somewhere else**, because that is the case that was
broken until it was tested:

```bash
cd ~/some-other-project
node ~/cairn/bin/cairn-find.js "curl exit 56 CONNECT tunnel failed"
```

You should get `cairn-0001` and a note about what it is confused with. If you
get "No corpus found", it is telling you where it looked.

## Tell your agent to use it

There is no URL to point an agent at, deliberately — see cairn-0014. The
delivery mechanism that works is the one this repository uses on itself: put it
in the project's instruction file, where an agent reads it before starting.

Paste into your project's `CLAUDE.md`:

```markdown
## Before you debug something, check whether it is already known

Paste the error you actually got — not a keyword, the error:

    node ~/cairn/bin/cairn-find.js "<paste the failure text>"

And before building in unfamiliar territory, describe what you are about to do:

    node ~/cairn/bin/cairn-brief.js "<what you are about to build>"

It stays silent when it has nothing, which is most of the time. Read the
`standing` before relying on a finding: `fresh` is safe, `stale` is a lead.

If you lose more than a few minutes to something that contradicted a reasonable
expectation, it belongs in the corpus: `cd ~/cairn && npm run cairn:new`.
```

## Identify yourself, so the traffic is worth something

```bash
export CAIRN_AGENT=your-name-or-model      # who is asking
export CAIRN_SESSION="$(date +%F)-$RANDOM" # which run
```

Every query is appended to `data/retrievals/<you>.jsonl` in the checkout: what
was asked, what came back, at what confidence.

One file per person, which is why sharing works. A single shared file conflicts
on the first exchange — two people, one query each, and the next pull stops to
ask you to resolve it. Measured, not predicted. Separate shards mean git has
nothing to reconcile, and `merge=union` covers one person on two machines. That file is the only record this
project has of its own delivery, and until it exists for more than one person
every measurement here is one author marking their own work.

It records the query text. If you work on something you cannot share, either
do not export `CAIRN_AGENT` or keep the checkout private — nothing is sent
anywhere, but the file is real and it is in git.

## What we are actually trying to find out

Not whether retrieval ranks well; that is measured and the numbers are in
`quality-baseline.json`. The open questions need other people:

1. **Does a second author's finding retrieve?** Everything here was written by
   one author in one session, so the vocabulary is internally consistent in a
   way a real corpus never is.
2. **Do duplicates arrive?** Survivorship and identity resolution are built and
   validated against duplicates that were generated, not encountered.
3. **Does anyone reach for it unprompted?** Measured once, on two models, with
   a wide gap between them. On a real project with a real habit, unknown.

A week of ordinary use answers all three better than any benchmark here.

## Sending your findings back

You are a collaborator on the one shared repository. There is no fork in this
model, deliberately: a fork stops receiving other people's findings and never
says so.


```bash
cd ~/cairn
git pull --rebase          # other people's findings and queries
npm run cairn:lint         # your finding must pass before it goes anywhere
git add cairn/ data/retrievals/
git commit -m "found: <what does not work>"
git push
```

Pull before you write a finding, so `cairn:admit` can tell you whether somebody
has already recorded it — that check is the difference between fifty thin
records of one trap and one record with fifty attesters.
