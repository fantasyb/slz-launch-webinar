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
| `/cairn why <question>` | `cairn:history "<question>"` — search the *reasoning* in git history, not just the corpus |
| `/cairn sync` | `cairn:sync` — pull the shared corpus and re-federate |
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
