# Forecast: field suite after eleven queries from four unseen traps

Sealed by committing before running cairn:field-eval on the extended set. The
suite stood at 11/11 answerable and 7/8 silent — every knob in the retriever
chosen while watching exactly those nineteen queries.

## What I expect

**8 to 9 of the 11 new queries first.** Point estimate 8/11, so the combined
answerable number lands near 19/22 = 0.86, down from 1.000.

Reasoning. Every one of these is situation-led — "persist sidebar collapsed
state across page loads", "review gate always reports success on pull requests"
— and situation-led phrasing is exactly what the expansion taxonomy gained
today, so this is the case the fix was built for. That argues for the high end.

Against it: three of the four traps are things I never tuned near. cairn-0022 is
numerical and its query says "correlation between pairs of time series", which
shares almost nothing with a finding about two CONSTANT series correlating at
plus or minus one — the searcher does not know constancy is the issue, which is
the whole point. I expect that one to miss. cairn-0009's query names
localStorage outright and should hit. cairn-0028's four phrasings name the
symptom precisely and should hit. cairn-0004's three are the least certain: they
say "optional fields with defaults" and the finding is about z.infer versus
z.input, so they may land on vocabulary the finding does not carry.

**Probability the combined answerable P@1 stays above 0.90: 0.35.**

## What would change my mind about today's work

If the new queries score at or above 10/11, the expansion taxonomy generalises
better than the tuning warranted and 1.000 was not as fitted as I have been
saying.

If they score below 6/11, then today's gains were substantially fitted to the
eleven queries that produced them, and the honest headline is the combined
number, not the one I reported.

---

# Reveal

The prediction above is unchanged. Recorded after running the suite.

| | predicted | actual |
|---|---|---|
| new queries first | 8/11 | **11/11** |
| combined answerable P@1 | ~0.86 | **1.000 (22/22)** |
| stays above 0.90 | p = 0.35 | **yes** |

Wrong, and wrong by underestimating — which is the direction I had been
guarding against all day and therefore the one I over-corrected into.

The specific call I got wrong is the informative one. I predicted cairn-0022
would miss, reasoning that "correlation between pairs of time series" shares
almost nothing with a finding about two CONSTANT series correlating at exactly
plus or minus one, because the searcher does not know constancy is the issue.
All three phrasings ranked it first. The expansion taxonomy carries the
situation the trap is met in, and "correlating a set of series" IS that
situation regardless of which pair turns out to be degenerate. Question-to-
question matching does not need the searcher to have named the mechanism, which
is the entire point of it and I still underestimated it.

My sealed decision rule was: at or above 10/11, the taxonomy generalises better
than the tuning warranted and 1.000 was not as fitted as I had been saying. That
rule fired and I am honouring it. Eleven queries from four traps that were never
tuned against, all rank one, is real generalisation evidence.

What it still is not:

  - one model writes the queries (claude-opus-5), so this measures how ONE
    model phrases a task, not how people do
  - four tasks, chosen by me, around traps I picked from my own corpus
  - every new query is ANSWERABLE. These agents asked one question each, at the
    start, about the task in front of them. Silence was not tested on new
    ground at all, and it is the half that protects the reader
