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
the tool as a `trigger`, which is what the PreToolUse hook matches on.

## The other half

`.claude/hooks/pre-tool-use.sh` reads the tool the agent is about to call and
prints anything recorded against it. Register it in `.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "*",
  "hooks": [ { "type": "command",
    "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-tool-use.sh" } ] } ] } }
```

Set `CAIRN_ROOT` to the install and `CAIRN_HOME` to your corpus if they are
not the same directory.

It is silent unless something is recorded, which is the common case. A hook
that speaks on every tool call is one you learn to skip.

## Before you start

Every query is written to `data/retrievals/` in the corpus and committed.
Tokens, home paths, email addresses and 18-character record ids are redacted
first; 15-character ids are not, because that shape cannot be told from
ordinary text without over-redacting everything.

**Use a private repository.** Findings about a vendor's tools, written by
someone who works there, are a decision for people who own that risk — not
one to make by default.
