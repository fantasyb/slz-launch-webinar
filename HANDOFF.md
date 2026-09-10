# Cairn — session handoff & punch-list (2026-09-07)

## Born-trusted capture, lazy verify-on-use (2026-09-10)

The offline promotion pipeline is GONE: `sleep.ts` (harvest), `consolidate.ts`,
`triage.ts`, `triage-trigger.ts`, `triageBrief.ts`, `triageScore.ts`, their
launchers, session hooks and tests. Measured on the pilot it admitted 0 of 24
candidates (`/tmp/cairn-live-pilot/drafts/.yield.jsonl`); every candidate was
narration or one-turn-recoverable, and it was the only place a stored command
ran with nobody watching. Everything below this heading that describes
"autonomous consolidation", the sleep queue or a triage agent is historical.

What replaced it, and where the invariants are pinned:
- Capture is in-session via `cairn_record` / `cairn_note`, unchanged, plus a
  soft generic-reflex refusal on the write path (`reflexBecause` overrides it,
  stored on the finding). An agent finding is born `aging` (0.45): the write
  path stamps the recording machine as the founding environment when the
  submitter omitted one (`test/record.test.ts`).
- THE CULL WIRE: an agent's `cairn_observe` is signed *attest-only* under
  `CAIRN_KEY` (`ObservationSchema.attestOnly`, bound into the signed payload).
  It counts in `disagreement()` — contests, zeroes confidence — and
  `confirm.ts:isOperatorPromoted` ignores it, so red-team #2 stays shut;
  `isOperatorPromoted` now also requires a VERIFYING signature, not a
  signature-shaped object (`test/cull-wire.test.ts`).
- Standing stays clock-based and pure. `use.ts` reads the ledger only to split
  `stale` into `dormant` / `stale (served N times since)` at render time and to
  weight `decayUrgency` by recent retrievals (`staleQueue`). `test/use.test.ts`.
- `mechanism` is labelled "author's inference, unverified" wherever rendered
  and never in the served block (`test/mechanism-label.test.ts`). `misled.ts`
  writes the ledger's first `misled` rows from fail-then-recover arcs
  (`test/misled.test.ts`); reconciled by `cairn:report` and the gateway's arc
  answer path.
- `cairn:daemon` keeps audit-verify + self-update only; the execution policy
  is untouched. No stored command runs unattended anywhere.
- An install strips the SessionEnd/SessionStart hooks an earlier version wired.

## Container execution follow-up (2026-09-08)

Added an opt-in offline Linux Docker profile through
`CAIRN_EXECUTION_MODE=container`, with immutable image references, no host mounts
or network, non-root execution, kernel resource limits and container cleanup.
See `CONTAINMENT.md` before enabling it. Default execution remains host mode.

This host cannot run the isolation proof: Docker/Podman are absent and Bubblewrap
namespace setup fails. Dedicated Docker CI must pass before deployment. No claim
of tested kernel isolation is made here. The independent reaper/systemd units require installation and the kill-and-reap
CI test. Aggregate host quotas and a controlled egress broker remain deployment
work; do not advertise the profile as a complete production containment system.


## Explicit approval follow-up (2026-09-08)

Opt-in production configuration: `CAIRN_TRUST_MODE=enforce` plus
`CAIRN_TRUST_BOOTSTRAP=explicit`. Missing approvals remain blocked across restart,
and the gateway cannot automatically add the prompt channel to a tools-only pin.
An operator imports exact reviewed material using `cairn:trust --approve-file
<file> --server <name> --sha256 <reviewed-digest>`. See `SECURITY_MODEL.md` for
capture, review and isolation requirements. Default TOFU behavior is preserved.

The trust CLI also now reads the actual server identity from hashed pin filenames
instead of hashing the already-hashed basename again; its roster is covered by
the HTTP lifecycle test. Absence of recorded drift is no longer described as
proof that live servers match approval.


## Approval integrity follow-up (2026-09-08)

The gateway now rejects corrupt/unreadable approval pins and rechecks approval
availability before cached dispatch. Removing an already-observed pin cannot
silently reapprove an upstream within the running process. Three real HTTP
attacks reproduced forbidden execution before the fix and verify denial plus
recovery afterward. See `SECURITY_MODEL.md` and `SECURITY_REVIEW.md`.

An independent `security-regressions.yml` checks these boundaries on Node 22/24
without provider secrets or write permissions. The existing quality guard and
trusted-base review requirements remain. The live remote guard run at `7029f43`
passed its full-test step but failed the quality guard; that does not attest to
these unpublished changes. The Node 24 warning in that log concerns the Actions
runtime, not a project Node-version mismatch (the job selects Node 22).

GitHub publication remains blocked: the connected integration's tree-creation
request returned HTTP 403, including an independent fresh-agent retry. Account
push permission is not evidence that this integration can write. Keep the local
commits on `claude/domain-connection-check-alvz1s`; do not merge old main.


Working document. Captures what was done this session, where we are, the
decisions waiting on a human, and the remaining work — written so a fresh Fable
pass (or whoever drives it) can execute top to bottom. Delete once consumed.

Branch: `claude/domain-connection-check-alvz1s` — inspected base `7029f43`, 348
commits ahead of `main`, open as **PR #3**. Dependency/doc follow-up below is
on this same branch; use `git log -1` for its current HEAD.

## Dependency and handoff follow-up (2026-09-07)

- Updated `next` and `eslint-config-next` from 15.5.12 to 15.5.25.
  Next still declares PostCSS 8.4.31, so a scoped override selects patched
  PostCSS 8.5.26. A scoped Sharp override selects the supported ^0.35.4 range
  rather than retaining vulnerable 0.34.x through Next's alternative range.
  The lockfile resolves Sharp 0.35.4 and the direct CSS tooling to PostCSS 8.5.28.
  Sharp's patched line requires Node >=20.9.0; package engines and dogfood
  prerequisites now state that minimum (CI already selects Node 22).
  Remove/revisit these overrides when upstream's declared dependencies are safe.
- The original branch lockfile audit reproduced **3 high-severity affected
  packages**, not 13: Next, its nested PostCSS, and Sharp. The updated installed
  tree reports **0 vulnerabilities** in `npm audit`. This is an advisory scan,
  not a proof of gateway security or deployment isolation. PostCSS's high
  findings include source-map file disclosure, not just its moderate XSS issue.
- Guard CI now installs the exact lockfile with `npm ci` and fails on high or
  critical dependency advisories. Neither change lowers retrieval quality floors.
- `DOGFOOD.md` now clones the working branch explicitly and describes automatic
  consolidation rather than implying all promotions wait for human review.
- Validation: production `npm run build` passed (including lint/type checking),
  CLI bundles built, corpus lint reported 0 errors / 57 warnings, ledger audit
  reported 0 failures, and Sharp resized/encoded an image successfully. The
  full suite via `node --import tsx --test --test-concurrency=2 test/*.test.ts`
  completed with 441 pass / 62 fail / 1 todo. This host denies the local socket
  created by the `tsx` CLI (`listen EPERM`); subprocess-dependent tests fail
  directly or through missing child output. A normal CI-host rerun is still
  required; this is not a fresh 503-pass attestation.
- Retrieval failures reproduced with the unchanged corpus and ranker:
  held-out P@5 0.8929, field quiet 19/23 (0.8261), and the
  `cairn-0001 -> cairn-0027` case. Three confidently answered negative queries
  about 429/retry/thundering-herd match `cairn-0051`, whose subject is socket
  reuse. The proxy case is pulled toward `cairn-0027` by the generated-question
  and coverage rankings despite the typed ranker preferring `cairn-0001`.
  No cases were re-labelled and no baselines were lowered.
- On a fresh checkout, doctor explicitly refuses execution under the default-off
  host policy and exits before SUMMARY. Do not classify missing SUMMARY as Node
  version noise without inspecting its stderr. The agent suite also depends on
  real commands producing the expected errors; an empty output aborts its CLI
  latency probe. Both need an explicit CI measurement design, not a blanket bypass.

The two merge blockers below remain open. The dependency patch does not certify
the earlier full-suite green claim on a fresh host.

## TL;DR

**Security follow-up:** a subsequent adversarial review reproduced and fixed
three permission/trust failures, despite the earlier hardening claims below:
conflicting safety hints bypassed strict read-only; reconnect reused stale RBAC
and trust approval; and trust enforcement failed open when approval could not
be persisted. See `SECURITY_REVIEW.md` and `test/gateway-adversarial.test.ts`.
All five new regressions pass, including real HTTP tests that prove denied
operations did not reach the upstream. Earlier "core is hard" wording is
historical, not a current security attestation.

Security-follow-up validation: 509 tests, **446 pass / 62 fail / 1 todo**.
The 62 failing test names exactly match the pre-security-change run on this
host; there are no newly failing tests. The five added tests account for the
five additional passes. Type checking, corpus lint (0 errors / 57 warnings),
and ledger audit (0 failures) pass. A normal CI-host full-suite run is still
required. GitHub publishing was retried by a fresh subagent at the user's
request and still received API 403 "Resource not accessible by integration";
the connection permits repository reads but these commits remain local.

- Full test suite **green** on the branch: `npm test` 504 tests, 503 pass, 1 todo,
  0 fail. `tsc --noEmit` clean. `cairn:lint` 0 errors. `cairn:audit` 0 failures.
- **The gateway core is hard** — five+ adversarial (Fable) passes, every finding
  fixed with a fail-before/pass-after test.
- **Autonomous consolidation shipped** — sleep now promotes harvested candidates
  into served, honestly-unverified findings with no human in the loop.
- **Merge to `main` is BLOCKED** by two things, neither of which is a product
  defect and neither of which blocks the dogfood: a real quality-baseline gate
  decision, and a CI workflow-context bug. Details below.

## What landed this session (all pushed to the branch)

Security hardening (each fix has a regression test):
- Defang core: memory-DoS fast path proven byte-identical by an exhaustive
  per-code-point soundness proof + differential fuzz; the `Ϲ→Σ` dead-confusable
  bypass closed and the whole confusables table audited; content-item / notification
  fields (`_meta`, `icons`, `resource_link.uri`, `completion.values`, progress
  `_meta`, `resources/updated`) routed through defang; draft/contradiction/note
  blocks made block-safe.
- Governance: `readOnlyStrict` no longer looser than `readOnly` against a hostile
  server; per-role `readTools` operator override (deny-beats-allow, auditable) as
  the escape hatch for the classifier's best-effort edges; own-tool name
  reservation so an upstream can't impersonate `cairn_find`/`cairn_record`.
- Hosted/multi-tenant arm: fail-closed on cleartext auth when bound non-loopback
  (TLS terminator required, not built in); per-tenant in-flight request + body
  caps (JSON-RPC batch bypass closed); reaper never reaps an in-flight session; a
  12-principal concurrency harness (`test/hosted-concurrency.test.ts`).
- Audit log: fabricated-offload-range, spill lock-squat, torn-tail, GC-liveness
  vectors closed (from earlier passes; verified still holding).

Autonomous consolidation (commit `7ca3e1f`):
- `src/lib/cairn/consolidate.ts` + `test/consolidate.test.ts`. Sleep promotes a
  candidate → served finding only when it passes the FULL `cairn_record` write
  path PLUS a machine gate (firsthand triple present, model-update surprise,
  non-reflex, cheap-score ≥ 0.7). Promoted findings are `cairn-sleep`-observed
  (never `doctor`), secondhand, manual-check, `aging`→`stale`, unsigned, never
  executable, `consolidated`-stamped. Runs at SessionEnd / SessionStart / daemon
  tick; `CAIRN_AUTO_CONSOLIDATE=0` kills it; steps aside where execution is on
  (the live gate owns the queue). Every candidate reaches a verdict; none dropped.

CI hermeticity (commits `35e6424`, `c8a856a`, `cfb9924`):
- Made env-coupled tests self-contained so a clean CI runner matches the dev box:
  `retrieval` execution-policy tests use a temp `CAIRN_POLICY`; `preflight` tests
  (retrieval + docs) assert env-independent triggers; both in-flight body-budget
  concurrency tests rewritten deterministic (single oversized body, no half-sent
  receive race — verified 5× stable).

## Where we are — the two merge blockers

### 1. `cairn:guard` quality-baseline gate (a DECISION, not a bug)
`npm test` passes in CI. `cairn:guard` (`research/scripts/guard.ts`) then fails.
Reproduced locally on the branch — **3 real regressions**:
- `heldOut P@5: 0.893 < 0.9`
- `field quiet-on-unknown: 0.826 < 0.9`
- `cases regressed: cairn-0001 → cairn-0027` (an unrelated finding now wins a
  query that should return the allowlist-proxy one — a genuine miss, not a reshuffle)

CI additionally showed `agent covered hits: 2 < 5` and `could not parse doctor
SUMMARY`. Earlier local runs passed, but that does not establish a CI root cause;
see the fresh-checkout policy and command-output findings above. The committed
workflow selects Node 22.

Cause: quality-baseline (`research/quality-baseline.json`, frozen at commit
`330dd79`) predates corpus growth; the corpus now has 51 findings (incl.
`cairn-0051` added this session), which reshuffles rankings. `cairn:guard`
explicitly demands a human decide: **fix the retrieval quality, or move the floor
with a documented rationale IN THE SAME COMMIT.** Do NOT silently lower a floor —
the gate exists to stop exactly that.
→ **Needs a human/Fable call.** See Open Decisions.

### 2. `review` CI job runs the wrong workflow context
The `review` job installs Prisma and fails on `Missing script: "cairn:lint"` — it
is executing against the **old `main` package.json** because the checkout
explicitly selects `github.event.pull_request.base.sha`. Old `main` is the
pre-Cairn Next.js app with Prisma and no `cairn:lint`. This is intentional trust
separation: review tooling comes from the trusted base, and only corpus/key data
comes from the PR. Switching to the PR head would run contributor-controlled
tooling with provider secrets. Bootstrap a separately reviewed Cairn review
toolchain onto the base before this corpus review can run; changing only the
workflow YAML on main is insufficient because its package/scripts must exist
there too. Confirm branch-protection required-checks before planning the merge.

## Open decisions (need the user)

Quality gate (blocker #1):
- Is `P@5` dipping to 0.893 and the `cairn-0001 → cairn-0027` case flip an
  acceptable consequence of a richer corpus (→ move floors with rationale), or a
  regression to investigate/fix (→ dig into why cairn-0001 lost that query)?

Self-improving harness (from the design pass; not yet built):
- (Q1) Should "dormant → retire" ever be automatic, or proposal-only?
  Recommendation on record: **proposal-only** (unused is the weakest signal;
  self-suppression failure mode is subtle).
- (Q2) Should unsigned agent refutations get retirement "teeth" (the gateway can
  never produce a signed observation)? Recommendation on record: **not yet**
  (a hostile upstream driving refutations could retire true findings).
- (Q3) Tune cadence: weekly vs "when ≥ 20 new labels exist".

## Remaining work — punch-list for Fable (in priority order)

**A. Get `main` live (finish the merge).**
   1. Resolve blocker #1: either investigate + fix the retrieval regression, or
      (per the user's decision) update `research/quality-baseline.json` floors in
      a single commit whose message documents the trade. Get `cairn:guard` green.
   2. Resolve blocker #2: fix the `review` workflow so CI runs the branch's
      package/scripts, not old `main`'s. Confirm required checks.
   3. Merge PR #3 → `main`. (A main-session/human step — verify CI green first.)

**B. Self-improving loop — Phase 0 ONLY (measure-only, zero automation).**
   Build `usefulness.ts` + `cairn:usefulness` (usefulness signals from existing
   ledgers: post-delivery `cairn_observe` confirmed/refuted, trial grades, human
   acts — NOT delivery counts/reminders, which are vanity), an auditable
   `cairn:retire`/`--undo`, the report/status/skill blocks, and the
   duplicate-of-retired → lead change. **Do NOT build auto-tuning yet** — there is
   no real usage data to tune on until the dogfood runs. Earn each later phase
   from real data. Full design essence is in "The design" section below.

**C. Cross-platform daemon (Linux + Windows).**
   The always-on daemon — which now also runs autonomous consolidation — registers
   under launchd (macOS only); `scripts/install-global.ts` skips it elsewhere with
   a manual note. Add first-class Linux (systemd --user) and Windows (scheduled
   task/service) registration + uninstall. Matters more now that the daemon
   promotes, not just triages.

**D. Later (gated on dogfood data + the Q1/Q2 decisions).**
   Self-improving Phases 1–4 (Tier-A retirement → tunables + self-tuning θ →
   ranking memory → Tier-B proposals). Propose-only code red-teamer
   (`cairn:redteam`) that opens PRs and NEVER merges — lowest priority.

## The self-improving design (essence; full 506-line proposal was produced this session)

Three layers over the existing recorders (all untouched): a pure `usefulness.ts`
derived record + `cairn:usefulness`; a git-tracked `cairn.tunables.json` (rails +
max step in code; missing = today's constants); `cairn:tune` (propose → prove on
the replay harness → apply-or-hold with a receipt, local commit, never push).

Usefulness signals (windowed, honest): confirmed-vs-refuted **post-delivery**
observations, machine/signed off-delivery confirmations, trial grades, human acts.
Vanity (printed, never tuned on): raw deliveries, reminders, description/index
surfaces, find hits, impact minutes, "didn't error". The loop NEVER writes an
observation itself (no fake "confirmed"); near-duplicates stay refused, not folded.

Tunables that self-tune ONLY after the eval harness proves the move on replayed
data, in-rail: `consolidate.threshold` θ (0.7, rails [0.6,0.9]); the consolidated
retire rules; `memory.span`/`minOutcomes` (ranking reputation — `memory.ts`
already exists, wired to nothing). Fixed on purpose: half-life, cost tiers,
reverify window, RRF k.

Retire tiers: Tier A (automatic, gated) = consolidated + no signed observation;
Tier B (proposal only) = anything signed/checked/federated/CLI-recorded. Rules:
contested-by-use → retire; dormant → retire (**recommend proposal-only**);
orphaned → retire; re-emergence → un-retire/propose. Never retire on "delivered
but unanswered" or "stale" alone. Retire, never delete.

Prove-then-apply: hash inputs → propose → gate replay (held-out F0.5 must not
fall) → retrieval replay on a temp corpus copy (`eval`/`field-eval`/`agent-eval`/
`case-guard`; per-case + `agent.minCoveredHits` floors) → delivery replay
(`resonates()` over trial transcripts) → pin check → apply + receipt + local
commit. Everything only ever changes corpus DATA and tunable PARAMETERS, never
gateway code; every change auditable and revertible; execution stays off.

11 named failure modes with harness catches — notably **self-suppression** (a
finding hides its own trap, looks unused, retires): resisted by only
auto-retiring findings that were NEVER shown, plus delivery replay + un-retire.

Five phases; Phase 0 is measure-only (build that first). Propose-only
`cairn:redteam` sketch: weekly, budget-capped, reproduces a hole before claiming
it, opens a PR with a sealed forecast, never merges, records the hole as a finding
about Cairn in Cairn.

## Dogfood — does NOT wait on any of the above

`DOGFOOD.md` is the 10-minute setup. Install puts the gateway in **stdio** mode in
front of `sf-all` (the path with the adversarial passes behind it). Do the merge
first for a clean `git clone`, OR clone and `git checkout
claude/domain-connection-check-alvz1s`. Do NOT use `--http 0.0.0.0` for the
dogfood — stdio is the tested path; hosted mode wants a real TLS terminator first.
End-of-week evidence: `cairn:report` + `cairn:impact` + one honest sentence.

## Path to enterprise — the hub-and-spoke platform

Where this is going: a **platform company**, not a single product. B2B, sold to
teams and businesses. The dogfood (one user proving the engine) is the proof
step, not the product's ceiling — the product is for companies running fleets of
AI agents against real systems.

### Self-hosted first (what it is, and the call)
Self-hosted = the customer runs the software **inside their own infrastructure**
(their cloud/VPC/servers/laptops), not on our servers. Their agent traffic, tool
calls, corpus and audit log never leave their perimeter; we ship software + signed
updates + a license. SaaS is the opposite (we host; their data lives on our infra).
**Call: self-hosted first.** It IS the "nothing leaves the machine" promise, it
removes the security buyer's #1 objection, and it needs no multi-region SaaS ops
to make a first sale. Cost: updates/support are harder (no hotfixing their box),
no central telemetry (design privacy-preserving opt-in metrics), licensing must
work offline. Foundation = the cross-platform daemon + one-command installer
(already on the punch-list). SaaS can come later if the market pulls.

### The business is the HUB; the products are the SPOKES
- **HUB** = the company + the shared platform substrate every product reuses:
  identity (SSO/SCIM), the org/workspace/RBAC model, the tamper-evident audit +
  compliance posture (SOC 2 certifies the platform once), billing/entitlements/
  metering, the admin console (one pane of glass), and the self-hosted install/
  update machinery. One login, one org, one audit spine, one trust story — across
  everything.
- **SPOKES** = products that plug into the hub. **Cairn (agent memory + governance
  gateway) is spoke #1.** Each additional spoke is an agent-infrastructure product
  that reuses the hub, so it ships faster and inherits the trust posture. Adjacent
  spokes (pattern, not commitments): agent policy/guardrails, agent audit/
  compliance reporting, agent eval/observability.

**The one engineering call this forces: build the enterprise layer as a REUSABLE
PLATFORM SUBSTRATE (the hub), not baked into Cairn.** `src/lib/cairn/enterprise.ts`
(auth, RBAC, tamper-evident audit) is the *seed* of that hub — as SSO / org model /
admin console get built, extract them into a shared platform layer so spoke #2
rebuilds none of it. That is the difference between "a product with enterprise
features" and "a platform company."

### Sequence (do not invert)
1. **Prove it** (weeks): dogfood + 2-3 design-partner teams. One team saying "this
   saved us" is the asset everything else rests on.
2. **Build the hub / productize for a team** (1-3 months; buildable — see track
   below).
3. **Make it legit** (parallel, 3-9 months; mostly NOT code): incorporate,
   DPA/MSA, security whitepaper, pen test, *start* SOC 2 Type II.
4. **Sell**: pricing, motion, first paid B2B contract.

Do not chase SOC 2 before a design partner commits. **SOC 2 is not built — it is
attested by an auditor after you operate controls for a window (Type II ~3-12
months).** What you build now is a product that is SOC-2-*auditable*; Cairn's
tamper-evident audit log is already the crown jewel of that story.

### Enterprise-readiness engineering track (buildable; AFTER proof) = building the hub
- **Identity:** SSO (SAML/OIDC), SCIM provisioning.
- **Org model:** workspace/org/team/role, extending the existing RBAC.
- **Audit/compliance controls (SOC-2-auditable):** access control, encryption at
  rest + in transit, change management, tamper-evident log + export (audit spine
  seeded by Cairn today).
- **Admin console:** `/cairn` grown into org governance — policy, seats, usage,
  the audit trail.
- **Self-hosted deployment:** cross-platform daemon (Linux/Windows), one-command
  installer, offline license/entitlement, signed auto-update.
- **Data residency / global:** per-region handling, GDPR export/delete, i18n.

### Non-code (the company; NOT something Fable ships) — flagged so nobody mistakes it
- SOC 2 Type II (auditor + operating window), ISO 27001, pen test, security
  whitepaper, DPA/MSA templates. Start once a design partner commits.
- Legal entity, funding, team, pricing, sales motion, support/on-call, global ops.
- Rule of thumb: **compliance = auditable controls (code) + attestation
  (business).** We build the first; the company runs the second.
