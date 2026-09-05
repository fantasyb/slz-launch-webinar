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
| `cairn:record` | the check in the submission being recorded, and its `absentWhen` | policy, and never under `strict` |
| `cairn:verify --run` | one named finding's check | policy + the `--run` flag |
| `cairn_record` (gateway, MCP server) | **nothing** — a finding recorded by an agent is never executed, whatever the policy says | `origin: 'agent'` in `recordFinding.ts` |

Search, brief, sync, federate, lint, publish and the web API never execute
anything.

## The gate

`~/.cairn/policy.json`, on the machine, keyed by which corpus it applies to:

```json
{ "/home/you/cairn": { "enabled": true, "note": "who decided, and when" } }
```

Absent, malformed, or `"enabled": false` — execution refuses. A malformed
policy is OFF rather than on, because the failure mode of guessing the other
way is running shell because somebody's JSON had a trailing comma
(`src/lib/cairn/policy.ts`).

**Outside the corpus, and that is the whole point.** The first version read
this file from the corpus root, and the corpus is a repository people clone —
so a policy committed upstream travelled to every adopter and enabled
execution on their machine by upstream's decision, and `cairn-sync` runs
`git pull`, so upstream could flip it later. This repository shipped
`{"enabled": true}` in the clone while this page claimed nothing runs unless
you enable it. It was exactly backwards.

Per machine also matches how an organisation wants to set it: one file device
management can write, that a user cannot silently override by pulling.

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

The exception is for a person. The same submission arriving through the
gateway's `cairn_record` tool, or the standalone MCP server's, was written by
a model out of text it read from an upstream tool — a record field, a Case
description, anything a third party can put into the system the agent is
reading. Every door goes through `recordSubmission()` in
`src/lib/cairn/recordFinding.ts`, and those two doors pass `origin: 'agent'`,
which never executes. There is no policy setting that turns that on.

## Bounds on anything that does run

- **A scrubbed environment.** Checks receive an allowlist — `PATH`, `HOME`,
  the proxy and CA variables, and little else — never the environment that
  launched them. It was the full environment until this was written, so every
  check saw every API key and cloud credential in the shell, and a check's
  stdout is captured and printed. The allowlist keeps the proxy variables on
  purpose: findings about an allowlist proxy cannot be evaluated without them.
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

With execution disabled — the default — no code path runs a command from a
finding, from any door. With it enabled, `cairn:record` from the command line
also runs the check in the submission it is recording, which is the caller's
own code, and `"strict": true` closes that. An agent's `cairn_record` never
runs it in either state.

## What this page does not claim

- A trap that lives in an environment variable outside the allowlist cannot
  be checked or gated at all. That capability is given up knowingly; the
  alternative is every check seeing every credential. Traps about the proxy
  variables are unaffected, because those are allowlisted.
- Checks are not sandboxed. They run as you, with your filesystem. Several in
  this corpus write temp files and make outbound requests; `cairn:gate` and
  `cairn:doctor` will show you which.
- `.claude/hooks/` is committed shell that your agent harness may run at
  session start. It is code arriving over `git pull` like any other, and it is
  reviewed the same way.
