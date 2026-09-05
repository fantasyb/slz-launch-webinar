# The first run against a real server: a null, and a forecast that was wrong

Recorded here, in this repository, because the run record and its seal live
in the operator's corpus home on his machine and this ledger would otherwise
carry only the runs that went the way the author hoped. The numbers below
are as reported by the operator's session; the record itself was not read
from here.

## The run

`scripts/gateway-trial.ts` at `18c2cbf`, against the operator's real
Salesforce org, through the stdio Salesforce MCP server he uses daily.
Three arms, five trials per cell, `claude-haiku-4-5`. Thirty of thirty
trials completed, exit 0, no refusals, no permission denials. Delivery on
the gateway arm 10 of 10. Findings and scenarios both written by the
operator: the author marking their own work, as the record says.

The findings under test described a trap in which the MCP server binds to
the wrong org, so a count comes back from the wrong data.

## The sealed forecast, and what happened

| scenario | control | empty | gateway |
|---|---|---|---|
| account_count | forecast 3/5, **observed 5/5** | 3/5, **5/5** | 4/5, **5/5** |
| contact_count | forecast 3/5, **observed 5/5** | 3/5, **4/5** | 4/5, **5/5** |

Scored per trial as a probability (a cell forecast of 3/5 is p = 0.6 that
any one trial is correct; each trial contributes (p − outcome)²):

| cell | Brier |
|---|---|
| account_count control / empty | 0.160 / 0.160 |
| account_count gateway | 0.040 |
| contact_count control | 0.160 |
| contact_count empty | 0.200 |
| contact_count gateway | 0.040 |
| **mean** | **0.127** |

Nine trials off across six cells, every miss in the same direction: the
forecaster expected the trap to bite the unaided arms and it bit nobody.
The single wrong answer (`contact_count / empty / #1`, answer `None`) is
the agent failing to emit the reply shape, not the trap; it counts against
the forecast anyway, because a forecast of correctness is a forecast of the
whole trial.

## What it falsifies

Not the gateway: delivery was ten of ten and `empty` equalled `control`
within a trial, which is what the design asks of it. Not the finding's
claim, either: a trap that did not fire in ten unaided trials on this box
is a trap this box does not currently have, which is a fact about the
box, and the finding's own `check` is the way to say whether it has moved
from "environment-specific" to "not here any more".

What it does falsify is the forecaster's belief about the *base rate* of
the trap on this org, today, and — more usefully — the scenario design: a
count question that the unaided agent answers correctly five times out of
five cannot show a delta whatever the gateway delivers. cairn-0034 says
this in general; this is the first time it has been measured on a real
server, and the answer was the one that finding predicts.

## What a run that could have shown something would need

A scenario whose control arm fails, measured before the gateway arm is
run at all: the trap's `check` confirmed live on this box on the day, or a
control-only pilot of five trials that comes back wrong. A forecast of
control 3/5 should have been preceded by evidence that the trap fires at
that rate here; it was a belief. The harness does not enforce that, and
this document is the argument for whether it should.
