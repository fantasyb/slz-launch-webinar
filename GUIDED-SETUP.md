# Guided Cairn setup

Start here when your agents and tools differ from someone else's. Cairn finds
existing connections, shows which it can connect, preserves your settings, and
checks whether your normal work actually passes through it.

## First installation

Install Node.js 22 or 24 and Git, then open a terminal and paste:

```bash
git clone --branch codex/guided-setup https://github.com/fantasyb/slz-launch-webinar.git cairn
cd cairn
npm ci --ignore-scripts --no-audit --no-fund
npm run cairn:build-cli
npm run cairn:setup
```

The terminal will guide you through:

1. Adding folders you work in. Paste a project folder's full path; press Enter
   when finished. Standard app locations and projects known to Claude Code are
   discovered automatically. Cairn does not search through your source files.
2. Reviewing the connections found. Each names the app, tool server, configuration
   location, and whether it can be connected automatically.
3. Closing the affected apps and choosing **yes** for all available connections,
   or entering just the connection numbers you want.
4. Choosing whether to automatically remember supported tool problems locally.
   Answer **yes** to test learning. This is opt-in; it does not run finding checks
   or share findings.
5. Signing in to selected browser-based tools. Cairn opens the provider login,
   then checks the connection and lists available tools before changing the app
   configuration. Failed connections remain unchanged and can be retried.
6. Restarting each app and accepting its MCP/trust prompts, if any.

You do not need to edit JSON or TOML yourself. Each selected configuration is
backed up privately before it changes. Existing credentials remain on your
machine. Project configurations will change on disk; review those changes before
committing a project, since generated paths are specific to your machine.

## Check that it is working

Ask each app to do a normal task with one of the named tool servers. Then run:

```bash
npm run cairn:setup -- --check
```

| Status | Meaning and next action |
| --- | --- |
| Available | Found but not connected. Run guided setup to choose it. |
| Connected — waiting for traffic | Configuration is in place. Restart the app, approve the connection if prompted, and use that tool. |
| Traffic verified | Cairn received a tool response through this exact installed connection version within seven days. |
| Sign-in needs attention | Run guided setup again. It offers browser reconnection for the affected tool. |
| Manual | Authentication or execution settings need another adapter. Keep using the original connection; it was not changed. |
| Disabled | The app configuration disables this server. Cairn leaves it disabled. |
| Legacy | A previous Cairn installer owns this connection. Manage it with that installer, or undo it there before migrating. |
| Changed | The connection, gateway build, or corpus changed or disappeared. Old activity does not verify the current setup. |

A tool error still proves that the upstream responded; it does not prove the task
succeeded. Transport failures alone do not verify coverage. The tool names shown
are tools actually used, not a complete list of available tools.

Rerun the check after adding tools or changing your setup. It rediscovers the
standard locations and saved project roots each time; it is not a background
monitor. New connections appear as available, and edited or removed connections
lose verified status. Add other projects with `--project /your/project`.

## What this version supports

| App | Configuration discovery | Automatic routing |
| --- | --- | --- |
| Claude Code | User `.claude.json`, its local project entries, selected/known project `.mcp.json` | Standard stdio and HTTP/SSE with explicit headers or browser sign-in |
| Claude Desktop | Standard macOS/Windows desktop JSON; Linux conventional path if present | Standard stdio; supported HTTP entries if configured |
| Cursor | User and selected/known project `.cursor/mcp.json` | Standard stdio and HTTP/SSE |
| Windsurf | User `.codeium/windsurf/mcp_config.json` | Standard stdio and HTTP/SSE |
| VS Code | Default user profile `mcp.json`, selected/known project `.vscode/mcp.json` | Standard stdio and HTTP/SSE; JSON comments/trailing commas retained |
| Codex | User and selected/known project `.codex/config.toml` | Standard table-based stdio and HTTP; client tool filters and local `env_vars` retained |

Command arguments and explicit environment values stay in client-interpolated
fields. The original client resolves supported variables such as `${env:...}`,
`${workspaceFolder}`, and `${input:...}`. Cairn forwards only explicitly declared
credential environment names; unrelated ambient credentials are not forwarded.
Working-directory settings and supported client approval/tool filters are kept.

Environment files, remote executors, managed or
plugin-provided connections, custom execution options, ambiguous TOML layouts,
linked files and unrecognized fields are not rewritten. The discovery report
shows these gaps where their configuration is visible. Header presence is not
proof that authentication will succeed; real use must verify it.

Standard path discovery is implemented for macOS, Linux and Windows. Automated
runtime tests currently exercise Linux. Native app behavior on each operating
system still needs a first-user acceptance test; the tests launch generated
configurations through the MCP SDK, not every vendor's desktop app.

**This does not cover every tool on your machine.** Built-in shell/browser tools,
direct API/SDK calls, hosted agents, remote environments, client plugins,
alternate profiles, policy overrides and projects not selected or discovered
can bypass this inventory. Client precedence and disabled tools may keep a
configured server unused. Cairn never reports a percentage of all your tools.

## Browser sign-in and recovery

For HTTP/SSE connections without explicit headers, setup checks the endpoint and
opens a browser if the provider requires OAuth. Sign in to the tool provider and
approve Cairn. If the browser cannot open, setup prints a link to open on the same
computer. `--no-browser` always prints that link. No passwords are entered in Cairn.

This supports standards-based MCP authorization with dynamic client registration,
PKCE, resource discovery, and refresh tokens. Public endpoints connect without
consent. Providers that require a pre-registered application, administrator
approval, a client metadata document, or proprietary authentication still need
that provider-specific integration; Cairn leaves the original app configuration
intact when the connection cannot be checked. It does not borrow credentials
from another application's private login cache.

Tokens live in private, URL-bound files under `~/.cairn/setup/oauth` with owner-only
permissions, outside the app configuration and corpus. Gateways refresh expiring
tokens without opening a browser. Revoked credentials or missing login files
appear as **Sign-in needs attention**. Run normal guided setup to reconnect;
`--login ID` also reconnects one configured tool. Unreadable regular credential
files are preserved privately for recovery before a fresh sign-in attempt.
Restart the affected app after reconnecting. Connection checks do not establish
usage coverage; a real tool response through the gateway does.

Local credentials and recovery copies remain after `--undo`, so undo can restore
configuration without silently deleting credentials. To disconnect OAuth access
fully, revoke Cairn in the provider's connected-app settings and remove the
corresponding private files when they are no longer needed.

## Learning and privacy

Each machine has its own private corpus, shared by its connected gateways.
Different connections with the same server name have separate coverage IDs.
This is a personal setup, not isolation for unrelated enterprise tenants.

For clients without a Stop hook, automatic capture checks completed candidates
when the connection has had no active tool call for 60 seconds, or when it closes.
That inactivity boundary is not proof the task ended. Existing capture gates still
admit only supported patterns; ordinary failures do not all become findings.

Discovery does not launch upstreams, open sign-in, or modify files. Selected
headerless HTTP/SSE connections are checked during installation using MCP
initialization and tool listing. Setup never calls upstream tools or uploads reports.
Coverage comes from normal use. To generate optional feedback:

```bash
npm run --silent cairn:setup -- --share > cairn-coverage.json
```

Review it and send it to Joey if you choose. It contains anonymous connection
aliases, app kinds, counts, capture and coverage states. No paths, server/tool
names, arguments, credentials, finding text, or identities are included.
`--json` is the local diagnostic format and includes names and paths; use
`--share` for feedback. Describe whether findings actually helped, were wrong,
or slowed work down. Counts alone do not measure task correctness or savings.

## Undo or migrate

```bash
npm run cairn:setup -- --undo
```

Restart affected apps. This restores only entries still matching what Cairn
installed; later user edits and unrelated settings are preserved. Conflicting
entries remain in the recovery record for manual review. Your corpus and private
backups are kept. Do not share the backups: original configurations may contain
credentials.

If you used the older Claude-only installer, `cairn:install -- --uninstall` manages
its entries and hooks. Guided setup reports those as legacy rather than wrapping
a gateway again. To migrate: undo the old installation, then run guided setup.
Guided setup does not add the old global instructions, update daemon, or Stop hook.

If setup is interrupted, its private manifest is written before configuration
changes. Run `--undo` to restore completed changes. If a stale `setup.lock` blocks
recovery, first ensure no other setup process is running; preserve manifest and
backups before removing that lock. Never delete the manifest to force reinstall.

## Additional options

```bash
# Inspect without changing anything
npm run cairn:setup -- --discover

# Include another project or a custom client profile
npm run cairn:setup -- --project /path/to/project
npm run cairn:setup -- --config vscode=/path/to/profile/mcp.json

# Explicit unattended setup, for an operator who reviewed discovery
npm run cairn:setup -- --yes --all-supported --autowrite
# Or select stable IDs printed by --discover
npm run cairn:setup -- --yes --only CONNECTION_ID
```

`--home /private/corpus` chooses a corpus outside the checkout. Private recovery
records default to `~/.cairn/setup`, separate from the corpus; `--state-dir` can
choose another private directory and must be used consistently for setup, checks,
and undo. `--check` exits 2 while any discovered connection lacks verified traffic
or a configuration is unreadable. That is a coverage gap, not a crashed setup.

To update: close the apps, pull the tested revision, run `npm ci --ignore-scripts
--no-audit --no-fund` and `npm run cairn:build-cli`, then restart and run `--check`.
Keep the checkout at the same path. Changes to setup itself do not silently
rewrite installed connections; undo and rerun guided setup when migrating them.

## Adapter references

Formats were checked against the official documentation:
[Claude Code](https://code.claude.com/docs/en/mcp),
[Cursor](https://cursor.com/docs/mcp),
[Windsurf](https://docs.devin.ai/desktop/cascade/mcp),
[VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
and [Codex](https://developers.openai.com/codex/mcp/).
