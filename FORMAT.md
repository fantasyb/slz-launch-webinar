# The finding format

A finding is a claim that something does not work, carrying the command that
would refute it. This page is for someone who takes the format and nothing
else — not the gateway, not the ranker, not this repository's tooling.

Three files are the whole contract:

| | |
|---|---|
| `spec/finding.schema.json` | The shape, as JSON Schema draft-07. Generated from `src/lib/cairn/schema.ts` by `npm run cairn:spec`; the test suite fails if they drift. |
| `src/lib/cairn/checkquality.ts` | The static rules a `check` must satisfy: its verdict is its exit status. |
| `src/lib/cairn/gate.ts` | The runtime proof: run the check, remove the trap, run it again, and refuse a check whose answer did not move. |

`npm run cairn:conform -- <dir>` applies the first two to any directory of
JSON files and `--run` adds the third, under the machine's execution policy.
It imports nothing from retrieval or the proxy. If it ever has to, the
format has stopped being separable, and that is worth knowing before anyone
depends on it.

## Why a check, and why an exit status

Memory that agents write is prose, and prose about an environment rots
silently: the mapping gets refreshed, the limit gets raised, the sandbox
changes, and the note stays confident. At fleet scale nobody reads it to
find out. The only form of memory that survives that is one where every
claim carries its own falsification test, so the system can ask itself
instead of asking a person.

That is what `check` is, and the rule that makes it usable by a machine is
narrow: **the verdict must be the exit status.** A check that prints a
result for a human to compare exits zero wherever a shell exists, so a
`doctor` that runs every check reports every finding live everywhere.
Measured on this corpus before the rule existed, 4 of 19 runnable checks
discriminated; `cairn:conform cairn` today reports 28 of 42 conforming and
14 with a check that cannot decide, all written before the rule. The static
rules in `checkquality.ts` refuse the shapes that produced those: a trailing
`echo`, a pipeline into `awk`/`tail`, an interpreter that prints the answer,
a dependency with no `command -v` guard.

## `absentWhen`: the half only the writer can supply

A check that exits 0 when the trap is present is half a test. The other
half is that it exits non-zero when the trap is gone, and only the writer —
who has just made the failure stop — knows what makes it gone. That is
`check.absentWhen`: the command that removes the trap on this machine.

The gate runs the check (expects exit 0: the trap is live here), then runs
`absentWhen` followed by the check in one shell (expects non-zero), and
refuses the finding if both exit 0. The delta is always applied on the same
machine, never compared across two: eight checks in this corpus grep their
way around the repository, and on a second machine they exit differently
because the repository is absent, not the trap. A one-machine delta cannot
be fooled that way.

`absentWhen` is optional. A trap with no on-machine remedy — a platform's
behaviour, a connector's — is `manual: true`, described in prose, inspected
and never run. Requiring a delta for everything would refuse the hardest
findings; the gate exists to refuse the checks that look like tests and are
not.

## `triggers`: what makes a finding come back

A finding is retrieved by search, and cairn-0035 measured that agents do
not search. `triggers` is the push half: the exact names of the tools,
programs or arguments the finding is about. A gateway matches them against
the tools it fronts and delivers the finding on the tool's description, on
the argument's schema, and on the result — before the decision, not after
the failure. `"query_records limit"` targets an argument; `"query_records"`
the tool; a client-side name like `mcp__records__query_records` is matched
as well.

## Scope, decay and provenance

`scope` defaults to `environment-specific`. `universal` is not asserted; it
is earned by confirmations across distinct environments and discounted
until it arrives. `halfLifeDays` bounds how long a confirmation is worth
anything: confidence halves over that span unless somebody re-runs the
check. Every `observation` names who saw it, where, and whether firsthand.
`visibility` is `private` until somebody promotes it, because evidence is
error output and error output carries what should not be shared.

## Minimum viable finding

```json
{
  "id": "cairn-0001",
  "title": "query_records returns an empty success when the default mapping is stale",
  "claim": "One falsifiable sentence.",
  "kind": "trap",
  "subject": { "name": "records MCP server", "ecosystem": "mcp" },
  "scope": "environment-specific",
  "cost": "hours",
  "expectation": "What a competent person would reasonably have predicted.",
  "reality": "What happens instead.",
  "workaround": "What to do instead.",
  "check": { "command": "...", "confirmedIf": "...", "refutedIf": "...", "manual": true },
  "provenance": "firsthand",
  "halfLifeDays": 90,
  "observations": [{ "at": "2026-09-02T04:00:00Z", "by": "who", "verdict": "confirmed" }],
  "triggers": ["query_records", "query_records mapping_id"],
  "createdAt": "2026-09-02T04:00:00Z"
}
```

Validate it with any JSON Schema validator against `spec/finding.schema.json`,
or with `npm run cairn:conform -- <dir>`.

## What the format does not do

It does not make a claim true. A check can be wrong, a writer can lie, and a
`manual` check is a sentence. What it does is make every claim *askable*:
a machine can tell a check that decides from one that does not, and can
re-ask a deciding check without a person. That is the property agent-written
memory otherwise lacks, and it is the reason the format is here rather than
inside the gateway that happens to deliver it today.
