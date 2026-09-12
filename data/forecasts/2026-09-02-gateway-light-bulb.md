# Forecast: an agent through the gateway, against one that is not

Sealed by committing before any trial with a model in it has run. The
fixture, the two findings and the harness are in the same commit; the only
runs that precede this seal are plumbing checks with an SDK client and no
model (does the proxy annotate `query_records` on this fixture — it does).

## The experiment

Claude Code in `-p` mode is the agent — the real client, over real stdio,
with its own deferred tool loading and permission model. It is given a
records API as MCP tools and a count question, and nothing else: no file
tools, no shell, no CLAUDE.md, no mention of traps or of Cairn. Its reply
is a number and the grader compares it to a truth computed from the data
arrays, never through the tools.

Three arms per scenario, same prompt, same upstream, same model
(`claude-haiku-4-5`), five trials each, interleaved:

    control   client -> fixtures/mcp/records.mjs
    empty     client -> gateway -> records, gateway has NO findings
    gateway   client -> gateway -> records, gateway has two findings

Two scenarios, chosen to differ on cairn-0034's second route:

    A  silent cap.  query_records returns 50 rows whatever `limit` says and
       signals nothing. Paging exists only behind an undocumented flag. The
       expensive honest route (partition by region, six calls) is possible
       but nothing on the machine prompts it; a result of exactly fifty
       rows is the only clue. Truth: 137 churned contacts.

    B  stale mapping.  Case's default mapping returns success with zero
       rows. A fresher mapping is one list_mappings call away — route two
       is OPEN — but zero is a legitimate answer to a count question, so
       nothing prompts the second look. Truth: 29 open Tier2 cases.

## What I expect

| cell | correct / 5 |
|---|---|
| A control | **0** (p(≥1) = 0.25 — a trial that partitions by region) |
| A empty   | **0** — the proxy changes nothing when it has nothing |
| A gateway | **4** — the finding names `include_paging`; the failure mode is a model that reads the note and still reports the first page |
| B control | **1** — one in five looks at list_mappings unprompted |
| B empty   | **1** |
| B gateway | **4** — the workaround is one call and the note arrives on the exact result that would otherwise be reported as zero |

**Delivery, from the client's transcript and not from the proxy:** in every
`gateway` trial at least one tool_result carries the proxy's label
(p = 0.9). The argument-schema and description surfaces reach the model
through ToolSearch results in this client, because MCP tools are deferred
(p = 0.7 that at least one gateway trial shows the label in a ToolSearch
result).

**Cost.** On B the gateway arm makes no more MCP calls than control (median
≤ control's). On A it makes MORE — three pages instead of one — and that is
the point: the calls are the work control skipped.

**Empty equals control** on both scenarios, within one trial. If it does
not, the proxy is doing something other than annotating and the gateway
number cannot be read.

## What falsifies the premise rather than disappointing it

- **gateway ≤ control on both scenarios**, with the transcripts showing the
  label arrived. Then delivery works and the finding does not change the
  decision — the "handed over, not asked for" result of `d4ca56b` does not
  transfer to a real client, and the product is a diary that is read and
  ignored.
- **Label never arrives in a gateway trial.** Then the client is not
  passing what the proxy adds — a delivery failure, which says nothing about
  value and everything about the surface. It would be the fourth time today
  that "the function returns the right string" and "the model receives it"
  came apart, and it would send this back to the proxy, not to the corpus.
- **control ≥ 4/5 on both.** Then both traps are derivable unaided
  (cairn-0034 route two open on both) and the experiment measured nothing
  the corpus can claim.

## What this does not measure, stated so it cannot be claimed later

The findings were written by me, about a fixture I built, with the trap
in front of me. This is the author-marks-own-work condition every prior
number here carries, and the sealed pilot forecast (`ff3f878`) is the one
that tests whether an outside writer produces such findings at all. It
does not measure a real server, a second model, the writer half, or
whether a note on a schema description is read when the tool is NOT
deferred. It measures one thing: whether, in the client people run,
findings delivered by the gateway change the answer.

## Smoke policy

One trial per cell runs first to prove the pipeline. Its outcome is
reported as the smoke result regardless of what it shows and is not folded
into the five.
