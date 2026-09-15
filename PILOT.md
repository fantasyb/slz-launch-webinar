# Cairn friend pilot

This pilot connects Cairn to the MCP tools you already use in **Claude Code on
macOS or Linux**, with Node.js 22 or 24 and Git installed. Start with one or two
tools you use for real work. Built-in shell, browser and other calls that do not
pass through these MCP connections are outside Cairn's view.

Each person installs their own gateway setup. The installer starts one local
gateway process per wrapped server; those processes share that person's private
corpus. Credentials and findings stay on that machine. This is not a shared
hosted gateway for unrelated customers.

## Install

Use a fresh checkout of the pilot branch:

```bash
git clone --branch codex/friends-pilot-readiness https://github.com/fantasyb/slz-launch-webinar.git cairn
cd cairn
npm ci --ignore-scripts --no-audit --no-fund
npm run cairn:build-cli
npm run cairn:install -- --autowrite --no-daemon
```

`--autowrite` opts this pilot into recording supported findings at task end.
Without that flag, capture still collects drafts but does not automatically
write findings. It does not execute their checks or share them. `--no-daemon`
keeps a fresh pilot installation on the version you installed; updating is manual.

The installer reads **user-scoped** servers in `~/.claude.json`, wraps stdio and
HTTP servers with configured headers, and preserves backups of the original
configuration. Headerless HTTP servers that may need OAuth are left direct.
Project `.mcp.json` files and other clients are not automatically configured by
this pilot installer. If you have only those connections, arrange a compatible
user-scoped connection before evaluating gateway activity.

Restart Claude Code. From the Cairn checkout, run:

```bash
npm run cairn:pilot
```

This checks registration and the standalone Cairn service without launching any
configured upstream. A connection reported as `wrapped` is configured; a real
call count above zero establishes that a task used it. A connection with zero
calls has not yet established live usage. `direct` means outside Cairn, and
`broken` explains a configuration/build problem. No wrapped connections means
the pilot has not started, even if the standalone Cairn tools work.

Then do a normal task that uses one of the wrapped MCP tools and run the check
again. You should see that connection's call count and last-call timestamp.

## What happens during work

- Tool calls continue through their existing servers.
- Findings in your local corpus may be added to relevant tool descriptions or
  results. A new private corpus can be empty; zero annotations is a valid result.
- The current automatic writer recognizes a limited set of misleading successes
  and contradictions. It rejects ordinary outages and wrong-path recoveries.
- When Claude Code stops a turn, a silent hook signals every local gateway for
  this corpus. Each gateway flushes completed capture candidates even while idle;
  no further tool call or client restart is required.
- A captured finding is private, unsigned and aging. Seeing an annotation does
  not establish that it changed the final answer. Most task outcomes are unknown.

Call duration in the report includes upstream execution. It is not isolated
gateway overhead or model latency. Task correctness, token savings and traffic
that bypassed Cairn are not measured by this report.

## Send feedback

After a few real work sessions, make an optional anonymous report:

```bash
npm run --silent cairn:pilot -- --days 7 --share > cairn-pilot-report.json
```

Review the JSON, then share it with Joey if you choose. This command sends
nothing. The export contains a code revision, anonymous connection aliases,
configuration/capture status, counts and timing. It excludes connection and tool
names, people, queries, arguments, payloads, finding text, credentials and paths.
`--json` is the fuller local diagnostic format; use **`--share`** for the export.

Include brief answers to these questions:

1. Did your normal work actually pass through Cairn?
2. Did anything stop working or feel slower after installation?
3. Did a finding help a later task, or was it irrelevant/wrong? Describe the
   behavior and outcome without sending private customer data.
4. Would you leave it connected, and what would make it useful enough to pay for?

Share the generated summary rather than your corpus, drafts, configuration or
raw logs. Those stay local and can contain details of your work.

## Change capture, update, or uninstall

To stop automatic writing while retaining the gateway:

```bash
npm run cairn:install -- --no-autowrite --no-daemon
```

Restart Claude Code after changing configuration. To update when Joey provides a
tested pilot revision, close Claude Code and run from the checkout:

```bash
git pull --ff-only
npm ci --ignore-scripts --no-audit --no-fund
npm run cairn:build-cli
npm run cairn:install -- --no-daemon
```

The installer preserves your current capture choice. Restart Claude Code and
check `npm run cairn:pilot` again. Your private corpus is outside the code checkout.

To uninstall:

```bash
npm run cairn:install -- --uninstall
```

Restart Claude Code. The original wrapped server entries are restored and Cairn's
managed hooks and instructions are removed. Your own hooks, private findings and
configuration backups remain. After verifying the restored setup, you can remove
the backups; they contain copies of the original configuration and credentials.

For a custom corpus/config location, use `cairn:pilot -- --home /absolute/corpus
--claude-json /absolute/config`. The command otherwise reads the installed
`CAIRN_HOME` from Claude's config, so it does not report the development corpus
as your personal activity.
