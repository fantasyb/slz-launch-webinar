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
