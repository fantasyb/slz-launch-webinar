# Cairn — dogfood setup (10 minutes, then forget about it)

You're helping test Cairn: memory for coding agents. It watches how your tools
actually behave, and when your agent is about to hit a trap someone already
worked out, it hands over the answer on the tool call itself. You install it
once and then work normally — there is nothing to do day to day.

## Install (once)

You need Node 20.9+ (Node 22 matches CI) and the Claude Code CLI. Then:

```bash
git clone --branch claude/domain-connection-check-alvz1s https://github.com/fantasyb/slz-launch-webinar.git cairn
cd cairn
npm ci
npm run cairn:build-cli
CAIRN_HOME=~/pilot npm run cairn:install -- --home ~/pilot
```

Then **restart Claude Code**. That's the whole setup — it wired itself into
every session, gave your machine its own signing identity, put your Salesforce
MCP server (`sf-all`) behind the gateway, and (on macOS) started a small
background daemon. No keys to make, no files to edit.

Each new session now runs a bounded, read-only readiness check automatically.
It checks the Cairn registration and corpus, then initializes Cairn's own built
MCP server and lists its tools. Healthy checks are silent. Missing/broken setup
produces a short notice but never blocks opening Claude Code. This does not
launch other upstreams, run corpus shell checks, install updates, clear quarantine,
or establish Linux containment. It verifies a fresh probe, not the connection
state of an already-open Claude session or the background daemon.

For an explicit machine-readable result, run
`node bin/cairn-health.js --home /absolute/path/to/your/corpus --json` from the
approved checkout. `ready` and `containment` are intentionally separate. Existing
installations receive the hook by rerunning the approved installer; source pushes
alone do not modify a user's Claude configuration.

To see exactly what it changed before committing, add `--dry-run` to the install
line — it prints every edit and writes nothing.

## Then just work

Use Claude Code on your normal Salesforce work. You don't call anything. When
your agent reaches for a tool a trap is recorded about, the warning rides in on
that call. When your agent hits and solves a *new* trap, it records it in the
moment (`cairn_record`, or `cairn_note` when there is no time) and it is served
from then on, marked `aging` — firsthand, one agent, this machine. Nothing
harvests your transcripts behind your back. Silence is the common case and not
a failure.

## How to tell it's alive

- `/cairn` in Claude Code → a dashboard of what it remembers and how fresh it is.
- `/cairn queue` → unfinished notes, and what is contested / stale / dormant.
  Review is optional, never required.
- `tail -f ~/pilot/drafts/daemon.log` → the daemon's heartbeat (macOS). It only
  verifies the audit chain and keeps the code current; it runs no checks.

## What's normal (don't report these as bugs)

- **A finding your agent recorded reads `aging`, not `fresh`.** One unsigned
  observer on one machine is what it is. It becomes `fresh` when a signed
  observation (yours, at the CLI) or a second machine confirms it. If a later
  session is served it and it does not hold, the agent says so with
  `cairn_observe` and it reads `contested`.
- **`dormant`.** The clock ran down and nobody has needed the finding since it
  was last confirmed. It is not less true; nobody built there. Leave it.
- **Nothing delivered on a given day.** Traps are rare. No news is fine.
- **"execution is not enabled"** if you run a check. That's intentional — this
  build never runs shell from the corpus on your machine. Leave it off.

## End of the week — this is the actual ask

Run these two and send Joey the output. This is the evidence the whole test
exists to gather:

```bash
CAIRN_HOME=~/pilot npm run cairn:report      # what the gateway delivered, per tool
CAIRN_HOME=~/pilot npm run cairn:impact       # rediscovery cost it may have saved
```

Plus one sentence: did it ever hand you something genuinely useful, or get in
the way? Honest is more useful than kind.

## Uninstall (whenever)

```bash
CAIRN_HOME=~/pilot npm run cairn:install -- --uninstall
```

Removes exactly what it added. Your corpus in `~/pilot` stays until you delete it.
