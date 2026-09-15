# September 2026 guard repair

The starting revision is `390d8c24096e53917865c6f009cb1afba912d50a`.
No quality floors, corpus records, generated expansions, field labels, or
per-case baseline outcomes were changed.

## Retrieval

Generated-question RRF previously gave full first-place credit even when the
best generated question explained little of the query. New corpus competitors
could therefore let a weak, unsupported question match overturn the other
rankers. Question weight now scales by its best coverage relative to the existing
query-explained threshold, capped at its existing full weight. Agreement with
another ranker's leader preserves the full question weight: corroborating
evidence still bridges the symptom/diagnosis vocabulary gap. This is a generic
rule, with no finding IDs or evaluation queries in the ranker.

HTTP/errno alias expansion also inflated confidence: one incidental `429`
contributed several matched words the caller never supplied. Confidence now
counts each literal source token's information once. An alias may explain its
source symbol, so `ENOSPC` still finds and explains disk-space trouble, but alias
words do not become additional independent evidence. Insufficient literal
coverage makes a result weak even when it shares an incidental status code;
the existing explicit program-match override remains.

Measured on the same corpus and query sets:

| Metric | Before | After | Unchanged floor |
| --- | ---: | ---: | ---: |
| Held-out P@1 | 0.8095 | 0.8333 | 0.79 |
| Held-out P@5 | 0.8929 | 0.9167 | 0.90 |
| Held-out MRR | 0.8565 | 0.8690 | 0.85 |
| Answerable held-out P@1 | 0.9054 | 0.9324 | 0.87 |
| Delivery | 0.821 | 0.845 | 0.80 |
| Field P@1 | 22/22 | 22/22 | 0.90 |
| Field quiet-on-unknown | 19/23 | 21/23 | 0.90 |
| Previously passing cases regressed | 1 | 0 | 0 |

All 22 positive field cases preserve their previous strong/weak labels (16
were already weak). The remaining unknown-query claims are still counted,
not excluded. These suites informed this repair, so improvements on them are
regression evidence, not a new independent generalization study.

## Reproducing the guard

`npm run cairn:agent-eval` still measures live host conditions. The guard now
uses `--controlled`: a real curl request encounters a local denying proxy, and
an empty PATH reproduces missing DNS tools. It does not expect a normal CI host
to have the original sandbox's blocked domains or missing tools. Expected
counts remain five covered hits and three quiet unknowns. Commands still run
and their actual output is retrieved; results are not replaced with canned
answers or counted as passing when skipped.

Doctor still requires an external, checkout-specific execution policy. The
disposable guard job explicitly creates that policy in `runner.temp`; it has
no provider secrets and checkout credentials are not persisted. Local runs
must make the same explicit decision for the checks they have inspected:

```sh
CAIRN_POLICY=/absolute/path/to/approved-policy.json npm run cairn:guard
```

The policy shape is documented in EXECUTION.md. The guard now explains an
execution-policy refusal instead of merely reporting a missing timing line.
The local verification ran the inspected checks with a task-scoped external
policy and measured a 1.607-second slowest check against the unchanged
5-second ceiling. Runtime is host-dependent.

## Bootstrapping trusted review tooling

PR #3 intentionally replaces the previous application. Its `main` base at
`edd1ba91e15e670bf695043509b700e9f614adf0` has no Cairn reviewer scripts.
Switching the secret-bearing review job to the PR head would defeat the
trusted-code boundary.

The workflow defaults to the base commit. During migration a maintainer may
set repository variable `CAIRN_REVIEW_TOOLING_SHA` to an independently approved
40-character commit SHA containing the required tooling. Branches, tags,
abbreviated hashes, and shell expressions are rejected. The pin is not selected
from PR input, and the tooling preflight runs before installing dependencies.
The trusted revision needs `cairn:lint`, `cairn:audit`, `test`,
`cairn:adjudicate`, and `cairn:review`, their code and dependencies, and the
review-panel configuration. Provider credentials and a responding review quorum
are separate requirements: a tooling pin is not evidence that the panel ran.

After independently reviewed tooling lands on the base, remove the variable
to resume base-commit review. No pin has been set by this change. Approving the
tooling revision is a maintainer decision, not an automatic consequence of
these retrieval tests passing.

Lint exit handling also now accepts only 0 and the documented warning code 2;
unexpected command failures remain failures. DEPLOY.md links the production
containment gate, including cgroup v2, seccomp, privileges, and the independently
installed reaper timer. This patch neither deploys the service nor certifies a
production host.
