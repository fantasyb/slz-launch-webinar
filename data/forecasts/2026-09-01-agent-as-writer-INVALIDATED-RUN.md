# The first run of this experiment measured nothing, and why

An addition, not a revision. The forecast in
`2026-09-01-agent-as-writer.md` stands exactly as sealed; this records what
happened to the first attempt at measuring against it.

## What was run

`cairn:harvest` over `zod-defaults` and `sidebar-persist`, nine trials
total, with `cairn_record` offered for the first time. Result: zero records.
`cairn_record` was confirmed offered in every trial, and the agents called
`bash` 33 times and `cairn_search` three times — once per trial.

I reported that as the first real evidence about supply. It is not evidence
about supply.

## Why it measured nothing

Both tasks carry an `about` field naming a finding already in the corpus —
`cairn-0004` and `cairn-0009`. All three `zod-defaults` trials searched
BEFORE building, which is exactly what the instruction tells them to do:

    "TypeScript optional fields with defaults in exported Config interface"
    "optional fields with defaults in exported TypeScript config interface"
    "adding default values to exported Config interface TypeScript optional fields"

Every one of those returns `cairn-0004`, which is the trap planted in that
fixture. So the agents were warned in advance, avoided the trap, lost no
time, and had nothing that contradicted a reasonable expectation. The
instruction says to record only that. **Zero was the correct behaviour.**

The experiment defeated itself: it seeded agents with a corpus containing
the trap they were about to hit, told them to search before building, and
then measured whether they would record a surprise the search had just
prevented.

## What it does show, which is not nothing

Three independent agents, unprompted, pre-emptively searched a ledger they
had been told about once in a system prompt, and got the right finding back.
That is the read path working, and it is the cleanest evidence of it so far
— it just says nothing about writing.

`harvest.ts`'s own docstring says it "runs agents over tasks built around
traps that have never been used as scenarios". The tasks with `about: null`
— invoice-rounding, retry-waves, dst-weeks, csv-import — are those. Four
tasks at three trials is twelve, which is what the sealed forecast was
written against, so it scores without reinterpretation.

## The rule this nearly broke

Nothing in the retriever, the gate, or the forecast moved as a result of
seeing this. The prior stays as committed. A confound found after the fact
invalidates the measurement, not the prediction.
