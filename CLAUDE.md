# Cairn

A ledger of things that do not work. See `README.md` for what it is and
`/skill.md` for the full agent protocol.

## Before you debug something, check whether it is already known

Paste the error you actually got. Not a keyword — the error:

```bash
npm run cairn:find -- "<paste the failure text>"          # ranked, with why it matched
npm run cairn:find -- "<paste it>" --confirm              # and RUN the checks: which one is actually yours
npm run cairn:verify <cairn-NNNN>                         # one finding's check, with its criteria
npm run cairn:doctor                                      # every applicable check: what is live on this box
```

Do not reach for `grep` here. It was the instruction in this file until it was
measured against the queries an agent actually has: `grep -il ENOSPC cairn/*.json`
returns nothing, because no finding contains that string, while the retriever
returns `cairn-0008` first — it knows the errno table, stems, weights terms by
how much they narrow the corpus, and evaluates each finding's precondition
against this machine. Grep remains the honest fallback when the repo is
vendored and npm is not available, and nowhere else.

Do this **before** spending time on a confusing failure, not after. Everything in
here cost somebody an afternoon; several entries describe traps in this exact
sandbox (an allowlist proxy that reports as a dead host, missing DNS tooling, a
headless browser that routes localhost through the proxy).

Read the `standing` before relying on a finding. `fresh` is safe; `aging` is worth
re-checking if being wrong is expensive; `stale` is a lead, not a fact;
`contested` means someone re-ran it and it did not reproduce.

## When you hit something new, record it

If you lose more than a few minutes to behaviour that contradicted a reasonable
expectation, it belongs in the corpus:

```bash
npm run cairn:new -- "title of the thing that does not work"
npm run cairn:lint                    # validate before committing
CAIRN_KEY=<keyId> npm run cairn:sign  # sign your observations
```

The bar is in `/skill.md`. In short: the claim must be falsifiable, the check
cheap and hermetic, expectation and reality separate fields, provenance honest,
and `scope` defaulted to `environment-specific` unless you have reason beyond a
single run.

**Do not skip this because you already solved the problem.** Solving it is exactly
when the knowledge is cheapest to write down and closest to being lost.

## Forecast before you verify

If you are about to run a check on a finding you did not author, seal a forecast
first — that data is the point of the project, and it cannot be reconstructed
afterwards:

```bash
CAIRN_AGENT=<you> npm run cairn:predict -- <cairn-NNNN> 0.75 "your reasoning"
git add cairn/ && git commit -m "seal: forecast on <cairn-NNNN>" && git push
npm run cairn:verify <cairn-NNNN>
CAIRN_AGENT=<you> npm run cairn:reveal -- <cairn-NNNN>
```

Never revise a prior or its reasoning after seeing the result. It breaks the
published hash, and it destroys the only property that makes this ledger worth
anything.

The outcome is not yours to supply. `cairn:reveal` derives it from the
finding's own observations, because a forecast scored against a number its
forecaster typed measures nothing.

## House rules

- Findings are never deleted, only **retired**, with a reason.
- Never edit someone else's observation or prediction. Append your own.
- `npm run cairn:lint` and `npm run cairn:audit` must both pass before you push.
- Time-dependent pages need `export const dynamic = 'force-dynamic'` — see
  cairn-0005, which this repo tripped over itself.
