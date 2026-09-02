# The gateway

Put it between your MCP client and the servers it uses. Every call is
forwarded and every result returned; the gateway only adds text, labelled,
from a corpus of findings you keep — and it lets the agent add to that
corpus from inside the session.

```bash
git clone <this repo> ~/cairn && cd ~/cairn && ./install.sh

# stdio, in front of one server (your client's mcp.json points here instead)
node ~/cairn/bin/cairn-proxy.js --server "npx -y @acme/their-mcp-server"

# stdio, wrapping every server in a client's config
node ~/cairn/bin/cairn-proxy.js --config ~/.cursor/mcp.json

# hosted: one process, one running copy of each upstream, a session per client
CAIRN_HOME=/srv/cairn node ~/cairn/bin/cairn-proxy.js --config servers.json --http 8787
#   -> http://127.0.0.1:8787/mcp   (CAIRN_HTTP_HOST=0.0.0.0 to expose it; that is a decision)
#   -> http://127.0.0.1:8787/healthz
```

`CAIRN_HOME` is the corpus: a directory with `cairn/` in it. Findings that
name a tool in `triggers` are the ones the gateway delivers.

## What the agent sees

Four surfaces, all of which are in context when a decision is made:

1. **At connect** — the server's instructions carry an index: one line per
   tool with a recorded trap.
2. **On the tool definition** — a labelled line on the tool's description,
   or on the specific argument's schema description when the finding names
   one (`"query_records limit"`).
3. **On the first result from each server** — the index again, because not
   every client honours instructions and every client reads a result.
4. **On the result of the tool the finding is about** — the finding in full,
   once per tool per session, then a one-line reminder every ten calls.

Two tools of its own: `cairn_find` (search the corpus) and `cairn_record`
(write to it, through the same gates as every other door: scanned, the
check must decide, near-duplicates refused, and — when the writer supplies
`absentWhen` and the machine's execution policy allows — the check is run
with and without the trap before the finding lands). A finding recorded
mid-session reaches the tool list before the next decision.

**The contradiction writer.** cairn-0045 measured that a writer keyed on
errors is blind to the traps worth recording, because those return success
with a plausible payload. What such a trap does leave behind, inside one
session, is a contradiction: a call returns nothing, or N items with nothing
saying more exists, and a later call to the same tool with the *same*
arguments plus one more returns what the first had implied was not there.
The gateway sees both halves. When it does, the working result carries a
labelled, hedged draft — both calls as evidence, the added argument as the
workaround — and asks the agent to record it through `cairn_record` if the
first result was wrong rather than merely a narrower question. Once per
tool per session. It never writes to the corpus itself.

The rules are rules for staying quiet, because a "this looks like a trap"
on every third result would teach the reader to skip the label that carries
the findings too: strict superset only (a changed value on a shared key is a
different question, so `limit: 10` then `limit: 100` never fires); a cursor,
token or page argument is a continuation, not a superset; a result that
declared its own incompleteness — `next_cursor`, `has_more`, `total`,
`done: false` — was not silent and is never the misleading half; only JSON
with something countable is compared. Replayed over the thirty committed
trial transcripts it was silent on all twenty non-recovering trials and
fired on five of five stale-mapping recoveries; it is expected to miss a
silent cap recovered by paging, which is a continuation, and the test pins
that miss so a change to it is seen. The real rate is `cairn:report`'s
drafts column over a fortnight of ambient use against the findings those
drafts became.

**The hole-to-draft loop.** A call that fails and a later call to the same
tool that works is the one shape the gateway can notice without an opinion.
The working result carries a draft — the failing call and its output as
evidence, the arguments that differed, the tool as the trigger — and asks
for the fields only the writer knows: expectation, reality, `absentWhen`.
The draft is also written under `drafts/` in the corpus home so a session
that ends without recording leaves the hole visible to a person. Once per
tool per session.

## What it writes down, and the report

Every emission by surface, every forwarded call, every error, every draft
and every record go to `data/retrievals/<client>.jsonl` under the corpus
home, tagged `mcp-proxy:*` — never `cli:find`, which is a person asking a
question. Arguments are redacted before they are written.

```bash
npm run cairn:report            # per tool: calls, errors, sessions warned, findings, drafts
npm run cairn:report -- --days 30 --json
```

The report counts delivery. It cannot count traps avoided, because a
success-shaped trap leaves no error; correctness needs a grader, and that is
what the trial below is.

## When the server's tools change under the corpus

Servers change. A connector adds a tool in a release, renames one, tightens
a schema, flips an annotation — and a finding whose `triggers` name the old
tool, or whose workaround names an argument the schema no longer has, is
knowledge rotting at exactly that moment. The gateway is the one component
that sits in front of a real server all day, so it is the one positioned to
see it.

It takes the tool list at connect as a baseline, re-reads it on every
`notifications/tools/list_changed` the server sends and on every listing a
client asks for, and diffs. A difference goes three places:

- **stderr**, where the operator sees it as it happens:
  ```
  cairn-proxy: salesforce: query_records → search_records (same schema and description)
  cairn-proxy:   cairn-0001 names query_records in its triggers and may no longer apply
  ```
- **the ledger**, as `mcp-proxy:surface-<appeared|vanished|renamed|annotations|schema|description>`,
  carrying the findings whose triggers name the tool. `npm run cairn:report`
  lists every change and, under it, the findings to re-read before trusting
  them.
- **the model**, once per change, on the next result from that server, in
  the same labelled block findings ride in:
  ```
  --- from your Cairn corpus, not from this tool ---
  This server's tools changed while this session was open:
  - query_records → search_records (same schema and description)
  Findings that name a changed tool, and may no longer apply as written: cairn-0001 (…)
  --- end ---
  ```

What it does not do, on purpose: withhold, rename or block anything. The
new tool is listed, the renamed one routes, the re-annotated one is called
exactly as the server now offers it. A client asked for that server, not
for this gateway's opinion of it (cairn-0046); enforcement belongs in the
trial, where a model runs unattended against production with nobody
watching. A gateway with no corpus notices on stderr only and appends
nothing, so it stays indistinguishable from no gateway.

Deliberately left for later: touching the findings themselves. The gateway
never writes an observation or retires a finding on the strength of a
diff, because a rename does not falsify a claim and a schema change may
not either — a person reads the report and decides. Drafting a finding
from a surface change is likewise left: the change is finding-shaped, but
the writer is the one who knows what it broke.

## What was proven, in the client people run

`scripts/gateway-trial.ts` drives Claude Code itself (`claude -p`, real
stdio, its own deferred tool loading and permission model). The run below
used the first version of it, at `5126812`, which was bound to
`fixtures/mcp/records.mjs`, a records API with two success-shaped traps:
`query_records` caps at 50 rows and signals nothing (paging exists behind an
undocumented flag), and Case's default mapping returns an empty success.
Three arms, identical prompt and model (`claude-haiku-4-5`), five trials
each; the forecast was sealed at `9d56723` before any model ran. Full data
and every transcript: `data/gateway-trials/run-2026-09-02T0529-haiku.json`.

| cell | exact | within 2 | took the route | note delivered | MCP calls |
|---|---|---|---|---|---|
| A control | 0/5 | 0/5 | 0/5 | — | 1,1,1,1,1 |
| A gateway, no findings | 0/5 | 0/5 | 0/5 | — | 1,1,1,1,1 |
| **A gateway** | **0/5** | **3/5** | **3/5** | 5/5 | 76,4,4,4,2 |
| B control | 0/5 | 0/5 | 0/5 | — | 1,1,1,1,1 |
| B gateway, no findings | 0/5 | 0/5 | 0/5 | — | 1,1,1,1,1 |
| **B gateway** | **4/5** | **5/5** | **5/5** | 5/5 | 3,3,3,4,4 |

"Took the route" is computed from the tool results in the client's own
transcript: for A, all 137 churned rows actually retrieved; for B, a query
through the fresh mapping. It was added after the smoke run, where a trial
paged all three pages and summed them to 136; the sealed forecast predicted
`exact`, and both are reported.

Read plainly: without the gateway, ten of ten trials on each scenario
reported the first page or zero and stopped. With it, the agent changed
route in eight of ten. On B that produced the right answer four times and
28 once. On A it produced 136 three times (the arithmetic, not the route),
a seventy-six-call expedition that probed ids one at a time after
paraphrasing "pass `include_paging: true`" into a `page_token` guess, and
one trial that read the note, repeated the same call, and reported 50.

What that does and does not establish:

- Delivery works in this client: the note reached the model in all ten
  gateway trials, on the result surface. The description and argument
  surfaces reach it through ToolSearch, whose transcript carries only tool
  references, so they cannot be verified from the transcript and are not
  claimed.
- A finding changes the decision on a silent, private trap. `empty` equals
  `control` everywhere, so it is the findings and not the proxy.
- The instruction has to be followable by the model reading it. Two A
  trials read the note and did not do what it said. A workaround naming an
  extension argument should state the type in words (`cairn-0044`).
- The findings were written by the author of the fixture. The sealed pilot
  at `ff3f878` is the test of whether anyone else writes them.
- One model, one client, one fixture, n=5. Not a real server.
- "Took the route" was a grader that knew the fixture's argument names. The
  harness no longer has one: it grades the final answer and records
  delivery beside it, nothing else.

## The same experiment, through the harness that takes its inputs from outside

Before the harness could be pointed at a real server it was re-run against
the same fixture from a scenario file in a home outside this repository,
sealed at commit `e0fc733` of that home, with the original forecast copied
in and the per-tool permission the harness derives. Five trials per
cell, same model, $0.86 in total, zero permission denials.

| cell | exact | note delivered | MCP calls | answers |
|---|---|---|---|---|
| A control | 0/5 | — | 1,1,1,1,1 | 50, 49, 51, 50, 50 |
| A gateway, no findings | 0/5 | — | 1,1,2,1,1 | 50 ×5 |
| **A gateway** | **1/5** | 5/5 | 4,4,4,4,5 | 138, 136, **137**, 136, 136 |
| B control | 0/5 | — | 1,1,1,1,1 | 0 ×5 |
| B gateway, no findings | 0/5 | — | 1,1,1,1,1 | 0 ×5 |
| **B gateway** | **5/5** | 5/5 | 4,4,4,3,4 | 29 ×5 |

The shape is the original's: control and empty identical and wrong on
both scenarios, delivery 10 of 10 on the gateway arm, and the gateway arm
changing route every time. The forecast, copied from the original seal, was
**wrong on A gateway**: 4 of 5 exact predicted, 1 of 5 observed, Brier
0.520 — the model paged all three pages every time and miscounted 137 rows
by one or two in four of them. An earlier version of this paragraph called
that "within what n=5 allows"; it was a miss, and the scoring the harness
now writes into every run record would have said so. B gateway came back
5 of 5 against a forecast of 4. Nothing in the harness change touches what
the model sees;
the gateway build differs only by the callTool relay fix (`cairn-0048`)
and the ledger no longer carrying argument values, neither of which
reaches a result. "Within two" is no longer a column: the harness grades
the final answer against `truth` with the `tolerance` the scenario file
sets, and this file set none.

## Repairs made between the seal and the run, stated rather than found

The scenario the seal described did not exist as built. The SDK wraps a raw
zod shape in `z.object()`, which strips unknown keys, so `include_paging`
never reached the handler and the finding's workaround was impossible
(`cairn-0043`). Fixed with `.passthrough()`. Then the model sent
`"include_paging": "true"` — a string, because an undocumented argument has
no type — and the handler tested for the boolean; fixed by coercing, and
the harness's own detector had the same bug (`cairn-0044`). Both are inside
what the smoke policy reserved and both are the corpus's kind of finding.

## Running the trial against your server

The harness takes the questions, the answers and the forecast from a file
you write, discovers everything else from the server itself, and refuses to
start until the run is safe and the forecast is sealed. This is the order
to do it in. Assume production credentials are loaded in the
shell you are typing into: nothing here needs them anywhere else, and
nothing here writes into this checkout.

### 1. A home outside this repository

```bash
mkdir -p ~/pilot/cairn && cd ~/pilot && git init
```

`~/pilot` is `CAIRN_HOME` for the run: the findings the gateway arm delivers
go in `~/pilot/cairn/`, the scenario file next to them, and the run record
and transcripts under `~/pilot/gateway-trials/` (which writes its own
`.gitignore`). The harness refuses a `CAIRN_HOME` that is unset or inside
this checkout, and refuses if `~/.cairn/policy.json` enables execution for
`~/pilot` — it should not, and by default it does not.

### 2. The findings

Write them with the gateway's own `cairn_record`, or by hand from the
template in FORMAT.md, into `~/pilot/cairn/`. Each must name the tool in
`triggers` exactly as the server offers it (`sf-query-org`, not
`mcp__salesforce__sf-query-org`; the gateway matches both forms). To see
the names, ask the server rather than guessing:

```bash
cd ~/cairn && npm run cairn:gateway-trial -- --discover "npx -y @salesforce/mcp --orgs DEFAULT_TARGET_ORG --toolsets data"
```

That connects, lists the server's tools, and prints which ones a trial
would let the agent call and why — no home, no seal, no model, no cost.
Read it once now; the same list is printed at the top of every run.

### 3. The scenario file: `~/pilot/trial.json`

The smallest file that works. You write the questions and their answers,
the forecast, and your name; the tools are discovered, the reply format is
added for you, everything else is defaulted.

```json
{
  "name": "salesforce",
  "server": "npx -y @salesforce/mcp --orgs DEFAULT_TARGET_ORG --toolsets data",
  "scenariosBy": "your name",
  "scenarios": [
    {
      "name": "open-tier2",
      "prompt": "How many Case records are Open in the Tier2 queue?",
      "truth": 29,
      "forecast": { "control": 1, "empty": 1, "gateway": 4,
                    "reasoning": "why you expect those counts out of five, specifically" }
    }
  ]
}
```

- **`server`** — the command line your client runs for it, as one string.
  Credentials come from the environment you run from; put none in the file.
  The client's name for the server is the trial's `name`, so tools become
  `mcp__salesforce__<tool>`.
- **`prompt`** — the question, and nothing about traps, findings or Cairn.
  The harness appends "use the tools available; reply with only
  `{"answer": <answer>}`", and that is what the grader reads.
- **`truth`** — the answer, obtained *some other way*: a report, a SOQL
  `COUNT()` in Workbench or the Developer Console, a Data Loader export.
  Never the tool the trial is about. A number or a string.
- **`forecast`** — how many of five you expect correct, per arm, and why.
  Written before the run, sealed by the commit in step 4, printed in
  brackets beside the result. `empty` is the gateway with no findings; if
  you expect it to differ from `control`, say why, because if it does the
  gateway number cannot be read.
- **`scenariosBy`** — who chose the questions and truths. The record
  compares it with who wrote the findings (`observations[].by`) and marks
  the run `independent` only when they differ. If you wrote both, the
  record says so in words, and so should anyone quoting the number.

**Which tools the agent may call is decided by the harness, not typed by
you.** It connects to the server, reads its tool list, and for each tool:
a tool the server declares `readOnlyHint: true` is permitted, by
declaration; one it declares `destructiveHint: true` or `readOnlyHint:
false` is excluded, by declaration, whatever its name; one that declares
nothing is judged by its name, and `create`, `update`, `delete`, `upsert`,
`execute`, `run`, … are excluded. A tool declared read-only whose name
nonetheless reads as a write is excluded too, with both facts printed, so
that trusting a server never lets through something the name rule alone
would have stopped. It prints the decision and the reason for every tool,
like this:

```
  permit   sf-query-org        declared read-only (readOnlyHint: true)
  permit   sf-get-username     no annotation; name reads as a read
  exclude  sf-deploy-metadata  no annotation; name reads as a write
  2 of 3 permitted. The agent can call nothing else.
```

Nothing that can write is ever handed to the unattended agent without a
written acknowledgement. On the proxy arms the gateway's `cairn_find` is
added; `cairn_record` never is, so a trial cannot be steered into
recording.

The full file, for reference — every field the minimal one left out, with
its default:

```json
{
  "name": "salesforce",
  "server": {
    "name": "salesforce",
    "command": "npx",
    "args": ["-y", "@salesforce/mcp", "--orgs", "DEFAULT_TARGET_ORG", "--toolsets", "data"],
    "env": {}
  },
  "allowedTools": ["sf-query-org"],
  "readOnlyDespiteName": { "sf-run-soql": "runs a SELECT through the query API and cannot write" },
  "scenariosBy": "your name",
  "scenarios": [
    {
      "name": "open-tier2",
      "prompt": "How many Case records are Open in the Tier2 queue?",
      "key": "answer",
      "truth": 29,
      "tolerance": 0,
      "forecast": { "control": 1, "empty": 1, "gateway": 4, "reasoning": "…" }
    }
  ],
  "model": "haiku",
  "trials": 5,
  "maxTurns": 40
}
```

- **`server` as an object** — the same `command`/`args`/`env` your client's
  `mcp.json` has, when the string form is not enough (an argument with a
  space, a non-secret `env` setting). `name` is what the client calls it.
- **`allowedTools`** — optional narrowing: only these wire names are even
  considered. Discovery still decides whether each may be called; a listed
  tool that reads as a write still needs `readOnlyDespiteName`. A name the
  server does not offer is refused, and the refusal prints the real list.
- **`readOnlyDespiteName`** — overrule an exclusion, by wire name, with the
  reason written down. The reason is recorded beside the decision it
  overruled. This is the only way an excluded tool reaches the agent.
- **`key`** — the JSON key the agent replies with; `answer` unless your
  prompt already asks for a specific shape (a prompt containing `{"` is
  sent as written, and `key` must match it).
- **`tolerance`** — for a numeric truth, an answer within ±n counts.
- **`model`, `trials`, `maxTurns`** — `haiku`, 5 per cell, 40 turns.

### 4. Seal it

```bash
cd ~/pilot && git add trial.json cairn/ && git commit -m "seal: gateway trial salesforce-pilot"
```

That commit is the seal. The harness refuses an uncommitted or modified
scenario file and writes the commit hash into the run record. Do not edit
the forecast after seeing a result; change it and it is a different run.

### 5. Smoke, then run

```bash
cd ~/cairn
npm run cairn:gateway-smoke -- --server "npx -y @salesforce/mcp --orgs DEFAULT_TARGET_ORG --toolsets data"
CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- ~/pilot/trial.json --smoke
CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- ~/pilot/trial.json
```

The smoke is no model and no cost, and proves the gateway is transparent to
this server. `--smoke` on the trial is one trial per cell, reported as such
and never scored against the forecast: it proves the prompt, the tool
selection and the grader before you spend five. The full run is three arms × five
trials per scenario, interleaved, two to twelve cents a trial on haiku and
more when the agent goes on an expedition. Each line as it lands:

```
A-open-tier2     gateway  #1  CORRECT answer=29 truth=29  mcp=3 turns=6 $0.034 23s  delivered=1/0
```

`delivered=1/0` is tool results carrying the gateway's label, on the result
surface and via ToolSearch. `DENIALS=1` on a gateway trial is usually the
model reaching for `cairn_record`, which is refused by design; read the
denial in the run record before trusting the trial; a denial of a tool the
selection excluded means the agent wanted something it may not have, and
`readOnlyDespiteName` is the only way to change that.

### 6. Reading it

```
SUMMARY (correct / trials, forecast in brackets)
  A-open-tier2     control 0/5 [1] (mcp avg 1.0)   empty 0/5 [1] delivered 0 (mcp avg 1.0)   gateway 4/5 [4] delivered 5 (mcp avg 3.2)
```

A good result: `empty` equals `control` within a trial (the proxy changed
nothing), `delivered` is 5 on the gateway arm (the note reached the model
every time), and `gateway` beats both. The run record is
`~/pilot/gateway-trials/run-<stamp>-<name>-<model>.json`: every trial's
answer, tool calls, cost, denials, delivery, the proxy's own ledger counts,
the seal, every tool the server offered with the decision and reason for
each, the exact prompts sent, the findings by id and author, and the
authorship caveat. Transcripts sit beside it, redacted line
by line before they were written; `--no-transcripts` keeps none.

**The run stops if the server's tools change under it.** One connection to
the server stays open for the whole run; before every trial, and once at
the end, the tool list is read again and compared with the one the tools
were chosen from. A tool that appeared, vanished, was renamed, changed its
annotations or its schema stops the run:

```
STOPPED — the server's tools changed under the run, before count empty #1:

  appeared     delete_records appeared (declared destructive (destructiveHint: true))

  1 trial(s) are in ~/pilot/gateway-trials/smoke-….json with stopped set; nothing after this point was run.
  Re-read the list, update the findings and the forecast if they need it, seal again, and run again.
```

The record carries the surface at start, every change seen, and the
surface at the end, so a result is never quoted against a tool list that
no longer existed. A change seen only by the final check is a warning, not
a stop: the trials ran against the surface at start, and the record has
both.

When an arm fails: a `control` trial with `ERROR=claude exited 1` and a
stderr tail naming the server means the upstream itself did not start —
run its command by hand and read stderr. `delivered 0` on the gateway arm
means no finding named the tool that was called; check `triggers`. `empty`
differing from `control` means stop and read the transcripts before
believing anything about the gateway arm. A trial killed at ten minutes is
recorded with `no result event`.

To recompute the transcript-derived fields of a run after a grader fix,
without paying for it again:

```bash
CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- --regrade ~/pilot/gateway-trials/run-<stamp>.json ~/pilot/trial.json
```

### What this run cannot tell you

If you wrote the findings and the questions, the gateway number is delivery
of a trap you planted: it says the note arrives and is acted on, not that
the corpus would have caught something you did not already know. The
cheapest way to buy the second claim is to have someone else write either
half — the findings from their own week with the tool, or the questions and
truths without seeing your findings — and put their name in `scenariosBy`.

## Before you point it at a server that matters

    npm run cairn:gateway-smoke -- --server "npx -y @acme/their-mcp"

No model, no key, no cost, about a minute. It connects three ways — straight
to the upstream, through the gateway with an empty corpus, and through the
gateway with `CAIRN_HOME` deliberately wrong — and asserts that the second
adds nothing but the gateway's own two tools, and the third is
indistinguishable from the first.

That last arm exists because of what happened the first time this was
pointed at a server nobody here wrote. `CAIRN_HOME` was set to a directory
with no corpus in it; a module-level `const KEYS_DIR = homePath('keys')`
threw during `require`, before `main()`; and the client's entire report was

    McpError: MCP error -32000: Connection closed

Thirteen working tools gone, with nothing in the message naming Cairn. The
trial harness could not have caught it — the harness seeds the corpus it
points at, so the misconfigured path did not exist in any measurement.
Recorded as `cairn-0046`; the rule it left behind (no library module
resolves the corpus at import time) is enforced by a test, and the gateway
now forwards untouched, withdraws its own tools and says why on stderr when
it cannot reach a corpus.

A gateway is a passenger. Its worst failure is not being useless; it is
being fatal to the thing it rides in.

## What is not proven here

Anything hosted beyond one machine: the HTTP mode is tested with two
clients on loopback, not with accounts, TLS or a network. The writer half
outside this repository. Any model but one.

A real MCP server is now half-proven: the gateway is measured transparent
to a third-party server (`@modelcontextprotocol/server-everything`) at the
protocol level. Whether real tools carry the kind of trap that made the
experiment work — a call that returns success with a misleading payload —
is still unmeasured.
