# "Bank that"

The block to paste into your `CLAUDE.md`, and what it does.

## What you say

**"bank that"** — mid-work, right after you have learned something about a
tool that did not behave the way you expected.

That is it. The agent writes the finding; you do not fill in a form.

## The block

```markdown
## Cairn — bank what does not work

When I say "bank that", record what we just learned as a Cairn finding:

    node ~/cairn/bin/cairn-record.js --file <finding.json>

Write the JSON yourself from what just happened. Six fields, plus `tool`:

- `title` — one line, what does not work
- `claim` — one falsifiable sentence
- `expectation` — what a competent person would reasonably have predicted
- `reality` — what actually happens instead
- `workaround` — what to do instead
- `tool` — the MCP tool this is about, exactly as it is named
  (`mcp__data360__query_records`). This is the field that makes it come back.
- `evidence` — the call you made and what it returned
- `check` — how someone would confirm or refute it. If reproducing it needs
  the connector, describe it in prose and it will be marked manual.

It refuses rather than redacts: a pasted credential, an injected
instruction, or a finding that already exists all stop the write and say why.

Never bank anything you would not publish.
```

## What `tool` buys

It is the difference between a diary and a loop. Set it, and the finding is
handed to whoever reaches for that tool next — including you, next week,
having forgotten. Without it the finding is only found by searching, and
cairn-0035 is the measurement that agents do not search.

Under the hood it fills in the subject, sets the ecosystem to `mcp`, and adds
the tool as a `trigger`, which is what the gateway matches against the tools
it fronts.

## The other half

Point your client at `cairn-proxy` instead of at the MCP server it wraps:

```bash
node ~/cairn/bin/cairn-proxy.js --server "npx -y @acme/their-mcp-server"
```

It forwards every call untouched and speaks on all four surfaces a decision
is made from: the instructions at connect, the tool's own description, the
argument's schema description, and the result. There is no hook, no client
feature, and it costs one to two milliseconds per call.

The gateway also offers `cairn_record` and `cairn_find` itself, so "bank
that" needs no second server, and when a call fails and a later call to the
same tool works it hands the agent a draft with the evidence already filled
in. `npm run cairn:report` says what it delivered, per tool. Hosting, the
trial that measured it in Claude Code, and its limits: GATEWAY.md. The
format it delivers, for anyone who takes neither the gateway nor the
ranker: FORMAT.md.

**Why not a hook.** There was one, and it was removed. Between the model
deciding on a call and the client executing it there is no model turn, so a
`PreToolUse` hook's text reaches the model alongside the RESULT of the call
it was about — after-the-action delivery, at 130ms per tool call against the
proxy's one to two. The only form of that hook which truly precedes execution
is `deny`/`ask`, which is a gate, and this is advice.

So "before the call" is really **before the decision**, and the surfaces that
are in context when a decision is made are the ones the proxy now writes to.

## Before you start

Every query is written to `data/retrievals/` in the corpus and committed.
Tokens, home paths, email addresses and 18-character record ids are redacted
first; 15-character ids are not, because that shape cannot be told from
ordinary text without over-redacting everything.

**Start in a private repository.** Not because of who wrote it — because of
what it is about, and the two are different:

- **Your org's state** — a stale mapping, a dropped connected app, a missing
  field. Private permanently. It describes your data, and nobody outside can
  act on it anyway.
- **How the platform behaves for anyone** — a tool that returns empty instead
  of erroring, a limit that is not where the docs say, an Agentforce pattern
  that fails silently. That is a hole every builder on the platform falls
  into, and it is the same category as "there is no `dig` in this sandbox".

The second kind is worth sharing and the first never is. `cairn:promote`
moves one finding up when somebody decides to; nothing is published by
default, and publishing anything about an employer's product is a decision
for people who own that risk rather than a setting.
