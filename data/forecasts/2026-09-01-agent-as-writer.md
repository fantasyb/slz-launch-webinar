# Forecast: does an agent record a trap it was not asked about?

Sealed by committing before running `cairn:harvest` with `cairn_record`
available for the first time.

## Why this is the only measurement that matters right now

Every experiment this project has ever run gave the agent `cairn_search` and
nothing else. `agent-trial.ts` and `harvest.ts` both defined exactly one tool.
So the corpus has measured, repeatedly and carefully, whether agents READ the
ledger — and has never once measured whether they write to it. Meanwhile the
40 findings that make up the corpus were written by an agent reading this same
instruction inside the repository that contains it, about that repository,
with its owner directing the session. Writer, subject and supervisor aligned.

The premise the whole design rests on is that an agent in a foreign project,
doing unrelated work, with the block in its instruction file and nobody
watching, records what bit it. That has never been run.

## What I expect

**Records attempted: 4 of 12 trials.** Point estimate 0.33.

**Passing the check gate: 1.** Point estimate 0.08 per trial.

Reasoning for the first number. The instruction is explicit and models comply
with explicit instructions in system context; that argues high. Against it:
these tasks are planted bugs in fixtures, and a planted bug is the agent's
job rather than a surprise — the instruction says "behaviour that
contradicted a reasonable expectation", and a bug you were asked to find
does not qualify. I expect most trials to correctly decline, and I expect at
least some of those declines to be right rather than a failure of the
premise. That distinction is the thing I am least able to measure and the
thing I most want the transcripts for.

Reasoning for the second. This is the number I am confident about, and it is
low for a reason I have already measured: across 40 findings written by an
agent with the schema in front of it, 4 of 19 runnable checks discriminate.
Writing `absentWhen` and a check that exits non-zero when the trap is gone is
writing a test, and the agent skipped that 15 times out of 19 with more
context and more supervision than these trials have. A rate of 1 in 12 here
would already be better than the corpus's own.

## What would falsify the premise rather than merely disappoint

Zero records in twelve, with transcripts showing the agent solved something
it had not expected and moved on. That says instruction-file compliance does
not transfer outside the repository that contains the instruction, and the
supply premise is wrong, not untested.

Records with zero passing checks AND no sign of iterating after a rejection
says something different and nearly as bad: the gate is a wall rather than a
filter, and the supply it admits is zero regardless of volume.

## What I am not measuring

Whether the findings are any GOOD. The gate tests whether a check
discriminates, not whether the trap is worth recording. A run that produces
four gate-passing findings about fixture bugs nobody will hit again is a pass
on supply and says nothing about value. That needs a different experiment and
I am not pretending this is it.
