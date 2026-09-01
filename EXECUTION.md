# What executes, when, and who wrote it

The one page to hand a security reviewer. Everything here is checkable against
the code, and the file paths are given so it can be.

## The short version

Nothing runs unless you commit a file saying it may. By default Cairn reads
JSON and ranks it, and that is all it does.

## What could execute at all

Exactly one thing: a finding's `check` — a shell command recorded alongside
the finding, whose purpose is to answer "is this trap present on this machine
right now". Three commands reach it:

| Command | What it runs | Gate |
|---|---|---|
| `cairn:doctor` | every applicable check in the local corpus | policy |
| `cairn:find --confirm` | up to 3 checks for the findings just matched | policy + the `--confirm` flag |
| `cairn:gate` | one check twice, to test whether it discriminates | policy |
| `cairn:record` | the check in the submission being recorded | `strict` policy |

Search, brief, sync, federate, lint, publish and the web API never execute
anything.

## The gate

`cairn.policy.json`, at the root of the corpus, in git:

```json
{ "enabled": true, "note": "who decided this, and when" }
```

Absent, malformed, or `"enabled": false` — execution refuses, with a message
naming this file. A malformed policy is OFF rather than on, because the
failure mode of guessing the other way is running shell because somebody's
JSON had a trailing comma (`src/lib/cairn/policy.ts`).

It is a committed file rather than a flag or an environment variable on
purpose. Enabling execution is then a reviewed commit with an author and a
date, disabling it is a revert, and a reviewer has one artefact to point at
instead of trusting that nobody typed a flag.

## Whose code runs

Only checks from findings loaded off local disk. `assertLocalCorpus`
(`src/lib/cairn/confirm.ts`) compares by object identity against a fresh load,
not by id or shape: a payload from an API can claim any id and reproduce any
structure, but it cannot be the same object the local loader produced.

**A check from a subscribed upstream corpus is never executed.** Federation
pulls other people's findings read-only, and their checks are displayed and
never run. Pointing an agent at a remote corpus that supplies commands is a
remote code execution primitive, which this project recorded as a finding
(cairn-0014) before building around it.

## `record` is the exception, and why

`cairn:record` runs the check contained in the submission it is recording —
code the caller wrote seconds earlier in the same session, to prove their own
check can tell the trap from its absence. That is running your own test, not a
stranger's.

Set `"strict": true` to refuse that too. The cost is real: it forfeits the
only mechanism that makes a recorded check verifiable rather than merely
runnable, so the corpus fills with checks nobody has established decide
anything.

## Bounds on anything that does run

- Written to a temp file and executed with `/bin/sh`, never string-interpolated
  from a query.
- Bounded wall clock, killed with SIGKILL on timeout; output capped at 1 MiB.
- `manual: true` checks are never executed at all — they are the ones needing a
  human, a paid API, or a specific host.
- Concurrency and a hard cap on how many run, so a broad query cannot become a
  build.

## The honest statement of the guarantee

With execution enabled, this is exactly as safe as running the test suite of a
repository you cloned, and no safer. The corpus is the thing to review, and it
is plain JSON in git with an author and a signature on every observation.

With execution disabled — the default — there is no code path that runs a
command from a finding.
