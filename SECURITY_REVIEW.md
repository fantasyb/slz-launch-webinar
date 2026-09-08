# Gateway adversarial review — 2026-09-07

Scope: a bounded source review and local adversarial tests against the working
branch, starting from dependency-fix commit `135086c`. All attack operations used
disposable local fixture servers, synthetic credentials, and marker files. No
production endpoints or customer data were attacked.

## Verdict

Cairn has useful security foundations, but the previous passing tests and
hardening passes did not establish that its permission and trust boundaries
held. This review reproduced three failures of those boundaries. Each has a
fix and a regression test. This is evidence of specific repairs, not a claim
that the gateway is fully secure or ready for enterprise deployment.

## Reproduced defects

| Defect | Preconditions and observed impact | Repair |
| --- | --- | --- |
| Conflicting annotations bypass strict read-only | An upstream advertises a read-looking name with both `readOnlyHint:true` and `destructiveHint:true`. A strict tenant could execute it even though ordinary read-only denied it. An explicit `readTools` entry did not prevent this. | A positive destructive declaration denies strict read-only before the heuristic/override path. |
| Cached approval survives upstream replacement | An initially approved read tool disconnects its upstream. The replacement advertises the same name with changed description and destructive annotations. A direct call without an intervening listing executes under the old approval, bypassing both RBAC and trust enforcement. | Routing metadata is bound to the SDK client connection that supplied it. Reconnect and listing occur before authorization; stale connection listings are discarded. Dispatch uses that same approved client without reconnecting after the decision. |
| Enforce mode permits calls when pin persistence fails | The approval directory is unusable. With `CAIRN_TRUST_MODE=enforce`, the gateway warns but still executes the upstream tool without a saved approval. | Failed pin persistence withholds tools and prompts in enforce mode. Missing approval also withholds server instructions. Monitor mode retains its non-blocking behavior. |

The fixture writes an independent marker when an operation executes. That marker
existed in each successful pre-fix attack and stays absent after the repair;
checking only an error message would not prove non-execution. The annotation
test also includes a permitted admin call as a positive control.

## Regression coverage

`test/gateway-adversarial.test.ts` contains:

- A 54-combination authorization matrix: three names, three values for each
  safety hint, and presence/absence of an explicit read override. Strict must
  never be more permissive than ordinary read-only under the same policy.
- A real HTTP strict-tenant call against conflicting annotations, including
  list filtering, refusal audit evidence, non-execution, and an admin control.
- Two real HTTP reconnect attacks, separately testing RBAC and trust enforcement.
- A deterministic pin-persistence failure using a file in place of a directory,
  testing denied tool execution and withheld prompt content.

Run the dedicated regressions with a fresh CLI bundle:

```sh
npm run cairn:build-cli
node --import tsx --test test/gateway-adversarial.test.ts
```

All five dedicated tests pass after the fixes. Type checking, corpus lint, and
ledger audit also pass. The full suite finishes at **446 pass / 62 fail / 1 todo**
out of 509 tests. Its 62 failing test names exactly match the pre-change run
on this host (441 pass / 62 fail / 1 todo); no new failures were introduced.
The environment denies the `tsx` CLI's local IPC socket (`listen EPERM`),
breaking child processes and assertions depending on their output. This
comparison is useful regression evidence, but is not a green CI attestation.

## What this review does not establish

- Tool names and annotations do not prove a tool's implementation is read-only.
  An upstream can lie consistently. Permissions on the actual upstream account
  and isolation of its execution remain necessary boundaries.
- Trust-on-first-use accepts the first observed surface. It detects subsequent
  visible changes; it does not prove the initial implementation benign or catch
  behavior changes that leave the advertised surface unchanged.
- Defanging Cairn-label forgeries is not a general solution to semantic prompt
  injection. Untrusted results can still contain persuasive instructions.
- A stdio subprocess is not an OS sandbox. Review the runtime identity,
  filesystem access, inherited environment, and network access of each deployed
  upstream. Likewise, multiple gateway principals sharing an upstream credential
  do not automatically gain upstream data isolation.
- This pass is not an exhaustive audit of every protocol route, parser,
  persistence race, resource-exhaustion vector, or deployment configuration.
  Passing tests cover the cases exercised, not arbitrary adversarial behavior.

## Next release gates

1. Reproduce a green full suite on the intended CI host, and resolve the existing
   retrieval regressions and trusted-base review bootstrap without weakening the
   quality floors or executing PR-controlled review code with provider secrets.
2. Define the supported deployment threat model: trusted local executables,
   remote untrusted servers, tenant identity, upstream credentials, and who may
   approve/change policy. Make production configuration match those claims.
3. Extend independent protocol/state-transition testing, especially reconnects,
   concurrent policy changes, incomplete listings, pin corruption, client
   disconnects, and long-running resource limits. The reconnect bug demonstrates
   why isolated happy-path checks are insufficient.
4. Obtain an independent security review before making enterprise security
   claims, and use real pilot outcomes to validate usefulness and false-positive
   costs. Security and useful retrieval are separate acceptance criteria.


## Approval-integrity follow-up — 2026-09-08

Three additional HTTP attacks at `fb4f6c4` corrupted JSON, replaced the prompts
field with a string, or deleted an approval after priming the routing cache.
All three executed the upstream operation before the fix. Cached trust decisions
were surviving the loss of their supporting evidence.

Pin reads now distinguish missing, valid, and invalid evidence. Malformed or
unreadable pins cannot trigger first-use replacement. Once a running gateway has
observed a pin, its disappearance cannot trigger replacement either. Enforce
mode checks evidence again before cached tool dispatch and prompt delivery.
Restoring the original pin and refreshing the listing restores service; each
attack test verifies that recovery with a real permitted operation.

`SECURITY_MODEL.md` records the authority-conservation contract and its limits,
including first use, process restarts, administrator-controlled files and work
already dispatched. The independent security CI workflow supplements existing
quality and full-suite gates; it does not weaken them.

Validation for this follow-up: the dedicated security selection passed 36/36
on Node 24.19.0; type checking passed; npm audit reported zero vulnerabilities;
corpus lint reported zero errors and 57 warnings. The full suite completed
513 tests: 450 passed, 62 failed, one TODO. Its failing test names exactly match
the prior 509-test run. The host's denied `tsx` CLI IPC remains visible in the
failures. A final change keeps approval disk reads out of the per-prompt listing
loop while retaining the dispatch check, and adds denied prompt delivery to the
damage attacks; the focused security selection and type check were rerun after
that change. The new GitHub matrix has not run: these commits are not published.

## Explicit enrollment follow-up — 2026-09-08

Added opt-in `CAIRN_TRUST_BOOTSTRAP=explicit`, requiring enforce mode. Production
cannot establish first-use pins or extend approvals to a previously unapproved
prompt channel. Deletion plus a gateway restart stays denied. Invalid bootstrap
configuration refuses startup. The operator imports reviewed content with a
SHA-256 digest and explicit server identity; rejected imports preserve existing
approval. This is an admission control, not process isolation or signed reviewer
identity. Deployment instructions and scope are in `SECURITY_MODEL.md`.

Validation: 40 focused security tests and seven existing proxy trust tests pass,
including HTTP first-use denial, actual approved execution, prompt-channel
separation, reviewed import, CLI roster, deletion-workflow refusal, deletion plus
restart, malformed configuration, digest mismatch and server mismatch. Types
pass. No dependency versions changed. The broad suite was not repeated for this
follow-up; its prior 450 pass / 62 fail / one TODO result remains the latest broad
run, not an attestation for this commit. Remote publication is still blocked.

## Execution containment follow-up — 2026-09-08

Implemented an experimental opt-in offline Linux Docker profile for stdio
upstreams. Reviewed immutable images run without host mounts or network, as a
non-root user with dropped capabilities, no-new-privileges, required seccomp,
read-only root, bounded scratch space and cgroup resource limits. The gateway
requires runtime prerequisites, never falls back to host execution, never pulls
images at runtime, and refuses invalid or conflicting configuration. It does not
pass ambient gateway credentials to the upstream. Declared credentials use a
private temporary env file; Docker administrators remain trusted.

The transport removes the entire container on close/failure/expiry. Cleanup
accepts an already-removed container only after the live daemon confirms absence;
real cleanup failure prevents further container launches until operator recovery.
An independent labelled-container reaper and systemd service/timer are included
for gateway-crash cleanup. `CONTAINMENT.md` documents installation, scope and
remaining requirements, including host aggregate quotas and controlled SaaS
egress. No Docker access is granted to upstream code.

Validation: 46 focused tests passed with two Docker integration tests skipped;
eight existing proxy compatibility tests also passed. Types and staged-content
scanning passed. Corpus lint reported zero errors / 57 warnings. The affected
container/reaper tests and types were rerun after explicitly setting never-pull
on container creation. The broad suite was not repeated for this follow-up.

This host has no Docker/Podman, and Bubblewrap namespace setup failed. Systemd
unit verification reported missing `docker.service` and `/usr/bin/node`; no unit
was installed or enabled. Actual file/network/privilege/resource isolation and
SIGKILL-plus-independent-reaper behavior have NOT been demonstrated here. The
new Docker CI job opts into those tests and must fail if Docker prerequisites
are absent, rather than skip. Passing that job and installing/monitoring the
supervisor on the target host are required before production use. These are
unpublished local changes; the prior GitHub write restriction still applies.
