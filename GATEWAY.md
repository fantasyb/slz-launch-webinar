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

## What was proven, in the client people run

`scripts/gateway-trial.ts` drives Claude Code itself (`claude -p`, real
stdio, its own deferred tool loading and permission model) against
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

## Repairs made between the seal and the run, stated rather than found

The scenario the seal described did not exist as built. The SDK wraps a raw
zod shape in `z.object()`, which strips unknown keys, so `include_paging`
never reached the handler and the finding's workaround was impossible
(`cairn-0043`). Fixed with `.passthrough()`. Then the model sent
`"include_paging": "true"` — a string, because an undocumented argument has
no type — and the handler tested for the boolean; fixed by coercing, and
the harness's own detector had the same bug (`cairn-0044`). Both are inside
what the smoke policy reserved and both are the corpus's kind of finding.

## What is not proven here

Anything hosted beyond one machine: the HTTP mode is tested with two
clients on loopback, not with accounts, TLS or a network. The writer half
outside this repository. A real MCP server. Any model but one.
