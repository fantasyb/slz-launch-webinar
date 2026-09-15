# harvest fixtures

Four small projects, each ordinary work that happens to sit on top of a trap
already in the corpus. They exist to make agents TYPE THINGS: `npm run
cairn:harvest` runs each task with the ledger available as a tool and writes
down every query issued, grading nothing.

    zod    a config schema gaining defaults          cairn-0004
    store  a sidebar remembering it was collapsed    cairn-0009
    stats  correlating six weeks of metrics          cairn-0022
    gate   a review job that passes everything       cairn-0028

The trap each was built around is recorded for whoever labels the harvest. It
is NOT a claim that any particular query is about it: plenty of what an agent
asks mid-task has no answer in the corpus, and those are the more valuable half,
because silence is a thing to measure.

Committed rather than left in a scratch directory so the harvest can be re-run
and disputed. None of these fixtures is referenced by the eval suites; they
produce queries, and the queries are labelled by hand afterwards.
