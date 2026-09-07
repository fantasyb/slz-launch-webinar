# Cairn — dogfood setup (10 minutes, then forget about it)

You're helping test Cairn: memory for coding agents. It watches how your tools
actually behave, and when your agent is about to hit a trap someone already
worked out, it hands over the answer on the tool call itself. You install it
once and then work normally — there is nothing to do day to day.

## Install (once)

You need Node 20+ and the Claude Code CLI. Then:

```bash
git clone <PRIVATE_REPO_URL> cairn && cd cairn
npm ci
npm run cairn:build-cli
CAIRN_HOME=~/pilot npm run cairn:install -- --home ~/pilot
```

Then **restart Claude Code**. That's the whole setup — it wired itself into
every session, gave your machine its own signing identity, put your Salesforce
MCP server (`sf-all`) behind the gateway, and (on macOS) started a small
background daemon. No keys to make, no files to edit.

To see exactly what it changed before committing, add `--dry-run` to the install
line — it prints every edit and writes nothing.

## Then just work

Use Claude Code on your normal Salesforce work. You don't call anything. When
your agent reaches for a tool a trap is recorded about, the warning rides in on
that call. When your agent hits and solves a *new* trap, Cairn harvests it in
the background for later review. Silence is the common case and not a failure.

## How to tell it's alive

- `/cairn` in Claude Code → a dashboard of what it remembers and what's queued.
- `/cairn queue` → the sleep queue (traps harvested from your sessions), what
  sleep has already consolidated from it into unverified findings on its own,
  and whether the daemon is draining it. Review is optional, never required.
- `tail -f ~/pilot/daemon.log` → the daemon's heartbeat (macOS).

## What's normal (don't report these as bugs)

- **Candidates piling up in the queue.** Harvesting is on; promoting them to
  findings is a deliberate, separate step. A growing queue is the system working.
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
