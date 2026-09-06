---
name: cairn
description: View and manage your Cairn memory — the ledger of tool and environment traps your agents have hit, with each finding's freshness (standing), rediscovery cost, and resonance signature. Use when the user types /cairn, or asks to see, browse, search, inspect, verify, retire, or add to what Cairn remembers, or to see what the gateway has delivered. This is the human front door to a system that is otherwise automatic and invisible.
---

# Cairn — see and manage your memory

Cairn's memory is a corpus of **findings**: a trap a tool or environment sprang on an agent, plus the workaround. Every finding carries three things this skill must always surface:

- **Standing** — `fresh` / `aging` / `stale` / `contested`. A stale ledger is worse than none, so never show a finding without it.
- **Cost / tier** — what rediscovering it costs (`minutes`/`hours`/`days`), which decides whether it is pushed in full or offered as an expandable hint.
- **Signature** — the resonance pattern, if set: the finding fires only when the live tool result matches it.

Keep replies tight. The user wants to *see* their memory and act on it — summarize, lead with standing, offer the next action. Never dump raw JSON.

## 0. Resolve the corpus home FIRST — it is not this repo

The memory lives at the machine's `CAIRN_HOME` (the `--home` it was installed with, e.g. `~/pilot`), never in the code checkout. Before running anything, resolve it in this order:

1. `$CAIRN_HOME` if set.
2. Otherwise read the installed home from `~/.claude/settings.json` — the `cairn-sleep.js` hook command carries `--home <path>` — or the `~/.claude.json` MCP server entry's `env.CAIRN_HOME`.
3. Otherwise ask the user, defaulting to `~/pilot`.

Run every command below from the Cairn checkout with that home, e.g. `CAIRN_HOME=<home> npm run cairn:status`. If a project corpus (`<repo>/.cairn`) is also present in the working directory, say so — the agent reads both.

## Argument grammar

`/cairn` with no argument → **the overview** (below). Otherwise route the first word:

| Input | Do |
|---|---|
| `/cairn find <query>` | `cairn:find "<query>"` — the retriever, ranked, with why each matched |
| `/cairn show <id>` | print one finding in full (see **Viewing**) |
| `/cairn usage [--days N]` | `cairn:report` — what the gateway delivered per tool |
| `/cairn check [<id>]` | `cairn:verify <id>` for one, else `cairn:doctor` for every applicable check on this box |
| `/cairn observe <id> confirmed\|refuted "<note>"` | record what you just saw (see **Managing**) |
| `/cairn retire <id> "<reason>"` | retire it — never delete (see **Managing**) |
| `/cairn holes` \| `/cairn drafts` | `cairn:unanswered` and the drafts in `cairn:report` — what's noticed but unwritten |
| `/cairn queue` | the **sleep queue** and daemon health — what is harvested and waiting for triage, and whether the always-on daemon is draining it (see **The queue**) |
| `/cairn trust` | the **security pins** — which wrapped servers are approved, and any tool that drifted from its approval (tool-poisoning / rug-pull). `cairn:trust`; `--reapprove <server>` after a legitimate change (see **Trust**) |
| `/cairn org` | the **enterprise access policy** — who may reach which servers, and mint/revoke tokens. `cairn:org list`; `init-policy`, `mint-token`, `revoke` (see **Enterprise**) |
| `/cairn audit-log` | the gateway's **tamper-evident access log** — every allow/deny/auth-fail under a policy, hash-chained. `cairn:audit-log view`; `verify`, `export` (see **Enterprise**). NOT `cairn:audit`, which checks the forecast ledger |
| `/cairn update` | bring the **code** up to date, safely: `cairn:update` (fast-forward only, rolls back a bad build). `--check` to preview (see **Updating**) |
| `/cairn why <question>` | `cairn:history "<question>"` — search the *reasoning* in git history, not just the corpus |
| `/cairn sync` | `cairn:sync` — pull the shared **corpus** and re-federate (findings, not code) |
| `/cairn add` | start a new finding (see **Managing → Add**) |

## The overview (default `/cairn`)

Gather, then synthesize into a short dashboard — not a transcript of the commands:

- `CAIRN_HOME=<home> npm run cairn:status` — is it being used, is it answering.
- Count `CAIRN_HOME/cairn/*.json` and break them down by **standing** (derive from each finding's `status`, `observations`, and `halfLifeDays`) and by **scope** (machine / project).
- `CAIRN_HOME=<home> npm run cairn:report -- --days 30` — deliveries per tool, the value it has returned.
- Open **holes / drafts** (`cairn:unanswered`, and the drafts column of `cairn:report`).

Present four things: **how much it remembers**, **how fresh** (the standing breakdown — flag anything `stale`/`contested`), **what it has saved lately** (usage), and **what needs attention** (stale findings to re-verify, drafts to finish). Lead with freshness.

## Viewing a finding

Always show, in this order: **title**; **WHAT HAPPENS** (`reality`); **INSTEAD** (`workaround`); **STANDING** (fresh/aging/stale/contested, when last confirmed, and whether a machine can even re-run its `check` — "attested once, never re-run" and "verified by its check today" must never read the same); **COST/tier** (full-push vs hint); and **SIGNATURE** if present (when it resonates). Offer: verify it, observe it, or retire it.

## The queue (`/cairn queue`)

The sleep queue is the harvested-but-not-yet-triaged candidates: raw leads scraped from past sessions, waiting for a triage pass to turn them into findings or reject them. They live in `CAIRN_HOME/drafts/` (never `cairn/` — a draft is unreachable by every reader until it is admitted). Show:

- **Waiting** — count and a one-line digest of `CAIRN_HOME/drafts/*.json` (skip `note-*`, which are the human note tier, not triage candidates). Newest first; name the tool each is about.
- **Draining?** — is the always-on daemon alive and ticking. On macOS: `launchctl list | grep com.cairn.daemon` (present = loaded), and the freshness of `CAIRN_HOME/daemon.log` (its mtime is the last tick's breadcrumb). If it is not loaded, say so and point at `cairn:install` to register it, or `cairn:daemon` to run it in the foreground.
- **Stuck?** — a queue that only grows means triage is not clearing anything: either execution is off for this corpus (the gate no-ops by design — say so) or nothing is clearing the bar (healthy). Do not imply a fault the daemon does not have.

Lead with whether the queue is being worked, then how deep it is. Never dump the raw candidate JSON.

## Updating (`/cairn update`)

Two different "updates", and they must not be confused:

- **`/cairn update`** pulls the **code** — the program that serves the findings. `CAIRN_HOME=<home> npm run cairn:update`. It is fast-forward only, clean-tree only, pinned to `origin`, and rolls back if the new code does not build, so it can never discard the operator's work or leave a broken checkout. For an enterprise install, set `CAIRN_UPDATE_REQUIRE_SIGNED=1` (and `CAIRN_UPDATE_ALLOWED_SIGNERS=<path>` for an SSH allowed-signers file): the target commit must pass `git verify-commit` before any fast-forward, so whoever can push to the tracked branch cannot turn the unattended daemon update into code execution as the operator. `--check` previews (change nothing). This is what replaces re-typing `git pull && cairn:build-cli && cairn:install`. The daemon also runs this on its own slow tick, so a machine with the daemon loaded stays current on its own; the command is the manual trigger for when you want it now.
- **`/cairn sync`** pulls the **corpus** — the findings themselves. Different thing, different command.

If `cairn:update` reports **local changes**, the checkout has uncommitted edits: report them and let the user commit or stash — never discard. If it **rolled back**, the upstream commit did not build here; say so and stay on the working version. After a successful update, note that a running daemon reloads on its next tick, or the operator can restart it to apply immediately.

## Trust — the security pins (`/cairn trust`)

Cairn's gateway sits in front of every wrapped MCP server, so it is the place to catch a server turning hostile: a tool whose **description or schema changes after you approved it** (tool poisoning / rug-pull), or a new tool that **appeared unapproved**. On first sight the gateway **pins** each server's tool surface (approve-on-first-use); after that, drift from the pin is a security event.

- `CAIRN_HOME=<home> npm run cairn:trust` — list the pinned servers and when each was approved.
- **Modes** (set at install into each wrapped server, `CAIRN_TRUST_MODE`): `monitor` (the install default) **flags** drift on the gateway's stderr and in the ledger but never blocks; `enforce` additionally **withholds** a changed tool from the model and refuses a direct call to it until re-approved; `off` disables it. Enforce with `cairn:install -- --enforce`; disable with `--no-trust`.
- When a drift is a **legitimate upgrade** (the server really did change), re-approve it: `CAIRN_HOME=<home> npm run cairn:trust -- --reapprove <server>`. That forgets the pin, and the next session re-pins to what the server offers then. Only do this once the change is confirmed benign — re-approving a poisoned surface trusts the attacker.

When showing trust, lead with **whether anything is withheld or flagged right now** (a live security event), then which servers are pinned. A drifted tool in enforce mode is not a bug to fix — it is the defense working; the action is to inspect the change and either re-approve or leave it blocked.

It installs and updates with everything else: every wrapped server is trust-`monitor` by default from the moment you install, and the daemon's self-update keeps the security logic current with the rest of the code — nothing separate to turn on.

## Enterprise — governed access and the audit trail (`/cairn org`, `/cairn audit-log`)

The same gateway is a personal loopback tool **and** a governed enterprise gateway, decided by one thing: whether an **org policy** (`CAIRN_HOME/org-policy.json`, or `$CAIRN_ORG_POLICY`) exists. With no policy, every client is the local admin, nothing is gated, and nothing is audited — the install you already have. With a policy that requires auth, the hosted gateway (`--http`) demands a bearer token, maps it to a principal, and lets that principal's role decide which servers and tools it may reach. This engages only on the HTTP path; a stdio personal install is never affected.

- **`cairn:org list`** (default) — show the policy: auth on/off, the roles, and the principals (by id and role; tokens are never stored or shown, only their SHA-256).
- **`cairn:org init-policy [--require-auth]`** — scaffold the policy (starter roles: `admin` unrestricted, `readonly` = write-looking tools denied). Refuses to clobber an existing one.
- **`cairn:org mint-token --id <who> --role <role>`** — generate a token, store only its hash, and print the raw token **once**. Hand it to the client as `Authorization: Bearer …` out of band (a secrets manager — never chat, never the repo). It cannot be recovered; mint a new one if lost.
- **`cairn:org revoke --id <who>`** — drop that principal's token(s). A running gateway re-reads the policy on change, so revocation takes effect on the next request without a restart.

Roles in `org-policy.json`: `allowServers` (strict allowlist), `denyServers`, `denyTools`, `readOnly` (deny any write-looking tool). **Deny wins**, and an unknown role denies everything (fail closed).

The audit trail is the other half — every decision the governed gateway makes is one hash-chained JSONL entry:

- **`cairn:audit-log view [--limit N]`** — the most recent decisions (who, what, on which server, allow/deny/auth-fail, plus the session and client), and whether the chain is intact.
- **`cairn:audit-log verify [--against <seq>:<hash>] [--against-file <path>]`** — re-walk the chain; any edit, deletion, reorder, or **tail truncation** (caught via the head sidecar) is detected and the exact line named. `--against` checks the live log still matches an anchor you are holding off the box; `--against-file` checks it against a whole off-box copy of the anchor chain (and verifies that copy's own integrity). Conflicting checkpoints for one seq are treated as tamper, never "last wins".
- **`cairn:audit-log anchor`** — checkpoint the current head `(seq, hash)` to store OFF the box (git, a WORM bucket, an email). It's the defense against someone who can rewrite the whole file *on* the box: they can re-hash the file end to end (the in-file chain's disclosed limit), but they cannot rewrite an anchor you already took off it, so `verify --against` catches the rewrite. The daemon anchors automatically on its verify tick, and `CAIRN_AUDIT_ANCHOR_CMD` (the anchor JSON on stdin) ships each one off-box.
- **`cairn:audit-log export [--out file]`** — stream the raw JSONL; it IS the SIEM feed.

Verification is automatic, not something a human has to remember: the always-on daemon re-walks the chain on a slow tick (`CAIRN_AUDIT_VERIFY_INTERVAL_SEC`, default hourly), raises a loud alarm on a break (dropping `CAIRN_HOME/audit/ALARM.json` so `/cairn` and the CLI surface it), and anchors the verified head off-box. If that marker is present, lead with it — the tamper-evident log detected a break, which is a security incident, not a bug to smooth over. Appends are also safe across processes (blue/green, a cluster): a cross-process lock serializes writers so concurrent gateways never corrupt the chain.

Two postures worth stating plainly when asked: writing the log is automatic (the governed gateway records every decision, no one turns it on) and verifying it is automatic (the daemon), so the audit is part of the always-on system, not a manual step. And a policy that EXISTS but is unreadable or invalid fails **closed** — the gateway refuses (503, or refuses to start) rather than silently reverting to the ungoverned personal mode; governance never turns itself off because a file was mis-saved.

When showing enterprise state, lead with whether the gateway is **governed at all** (is there a policy, is auth required) — an ungoverned gateway has no principals and an empty audit log by design, which is not a fault. `org-policy.json` and `audit/` are local governance state (gitignored on install); they are never corpus content and never leave the machine unless exported.

**Do not confuse `cairn:audit-log` (the gateway access log) with `cairn:audit` (the forecast-ledger integrity check).** They are different commands for different things.

## Managing

- **Verify** — `cairn:verify <id>` (one) or `cairn:doctor` (all applicable here). This is what turns a timer-decayed guess into a check-backed standing; suggest it for anything `aging`/`stale`.
- **Observe** — `CAIRN_KEY=<keyId> CAIRN_AGENT=<label> npm run cairn:observe -- <id> confirmed|refuted "<what you saw>"`. For the manual half of the corpus this is the *only* observer it will ever get. Never invent an observation — they are signed and scored, and a fabricated one corrupts the ledger.
- **Retire (never delete)** — house rule: findings are retired, not removed. Set the finding's `status` to `"retired"` and fill `retiredReason` with a real reason, then run `cairn:lint`. Explain to the user why it is retired rather than deleted (the record of what was once true, and why it stopped, is the point).
- **Add** — `cairn:new` to scaffold, edit the draft, `cairn:draft <file>` to scan it for anything that must not leave the machine, then `cairn:sign` and commit. The bar for `cairn/` does not move: a falsifiable claim, a cheap hermetic check, expectation and reality as separate fields. **Never generate a private signing key that travels through chat** — the user makes their key on their own machine (`cairn:keygen`).
- Before pushing any corpus change: `cairn:lint` and `cairn:audit` must both pass (house rule).

## Forecast before you verify someone else's finding

If you are about to run a check on a finding you did not author, seal a forecast first (`cairn:predict`), commit it, then `cairn:verify`, then `cairn:reveal`. Never revise a prior after seeing the result — it breaks the published hash and destroys the only property that makes the ledger worth anything.

## Safety

- These commands read and write **locally**. Nothing leaves the machine unless the user commits it to a repo they already trust. Say so if they seem to expect a shared database — there isn't one.
- Query text and ledger rows *are* committed to git; evidence can carry secrets, which is why `cairn:draft` scans before anything is published. Respect it.
