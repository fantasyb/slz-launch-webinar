# research/

The measurement programme: the machinery that produced the numbers the
product's claims rest on, kept runnable and kept out of the way.

The product is the corpus (`cairn/`), the CLI (`bin/`), the gateway
(`scripts/mcp-proxy.ts`) and the format (`spec/`). This directory is how the
retriever, the delivery paths and the calibration ledger were measured, and
it exists so those measurements can be re-run and disputed. Nothing in it is
imported by the product; the guard imports nothing from the product it does
not test through a spawned command.

Every `npm run cairn:*` script still resolves; only the files moved.

| | |
|---|---|
| `scripts/guard.ts` | The floors. `npm run cairn:guard` runs eval, agent-eval, field-eval, case-guard, lint and doctor concurrently and fails if any floor in `quality-baseline.json` is breached. CI runs it on every push. |
| `quality-baseline.json` | The floors themselves, with the note explaining each. Raise one when a change earns it; never lower one to make a build pass. |
| `scripts/eval.ts`, `agent-eval.ts`, `field-eval.ts`, `case-guard.ts` | The suites the guard runs: held-out accuracy, the corpus used as an agent would, real harvested queries, and per-case regression against `data/case-outcomes.json`. |
| `scripts/agent-trial.ts`, `grader-selftest.ts` | Does an agent reach for the corpus unprompted, and do the graders that decide that separate pass from fail. CI runs the self-test. |
| `scripts/harvest.ts`, `fixtures/harvest/` | Record what agents actually type on tasks built over known traps. Produces `data/field-queries.json`. |
| `scripts/panel.ts`, `panel.config.json`, `panel-runs/` | Several models forecasting the same sealed claims. `panel-runs/` holds the manifests, under the corpus licence (CC-BY-4.0) because they are sealed forecasts, not code. |
| `scripts/baseline.ts`, `bench.ts`, `quick.ts`, `spectrum.ts`, `semantic-ceiling.ts`, `eval-audit.ts`, `simulate.ts`, `backfill-ledger.ts` | Is any of this better than BM25; end-to-end latency; all suites on one line; whether embeddings could help; whether the residual is meaning or labels; how much of the held-out set is not a query; a synthetic corpus; seeding the ledger from trials. |
| `fixtures/ledger/`, `fixtures/trials/` | Project shapes the agent trials run inside. `fixtures/mcp/` and `fixtures/trials/gateway/` stayed at the root: they are the product's own tests. |

What stayed in `data/` and why: `case-outcomes.json`, `field-queries.json`,
`harvest-records.json` are read by the suites here, but `expansions.json` and
`word-frequency.json` are read by the retriever at query time and
`field-queries.json` by the corpus linter, all through `homePath('data', …)`
— `data/` is part of a corpus home's layout, so it moves with a corpus, not
with this directory. `data/forecasts/` and `data/gateway-trials/` are the
gateway's own sealed experiment and belong beside `GATEWAY.md`.

Everything here runs from the repository root: `npm run cairn:guard`, not
`cd research`.
