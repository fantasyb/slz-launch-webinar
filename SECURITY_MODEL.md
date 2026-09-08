# Authority conservation in Cairn

This is a design rule and a testable contract, not a claim of new mathematics or
an unbreakability proof. It applies to upstream tool dispatch with organization
policy enabled and `CAIRN_TRUST_MODE=enforce`.

An operation may execute only when all three conditions hold at dispatch:

1. The current caller policy permits the advertised operation.
2. The operation's advertised surface matches intact approval evidence.
3. The connection receiving the operation is the connection whose surface was
   evaluated.

Passing one check cannot compensate for failing another. A restart is not an
approval, a read-looking name cannot override a destructive declaration, and
lost evidence cannot become permission. The conservation-law analogy is useful
because it asks where authority came from; it does not prove the implementation.

## Enforced transitions

| Transition | Gateway behavior | Executable evidence |
| --- | --- | --- |
| Ordinary read-only becomes strict read-only | Permission cannot expand under the tested hint/override combinations | `test/gateway-adversarial.test.ts`, 54-combination matrix |
| Upstream disconnects and reconnects | List and evaluate the replacement before dispatch; route through the evaluated client | Separate HTTP RBAC and trust reconnect attacks |
| Approval cannot be saved | Withhold tools, prompts and unapproved instructions in enforce mode | Deterministic failed-write attack |
| Existing approval becomes corrupt, unreadable or missing | Deny cached tool dispatch; do not overwrite damaged evidence or silently repin a previously observed approval | Three HTTP damage attacks and pin-state validation tests |
| Original approval is restored | Complete listing re-evaluates it and restores permitted service | Positive control in each damage attack |

The denial tests check a marker written by the upstream operation, not just a
gateway response. An error after executing a forbidden operation is a failure.
Pin validation rejects malformed fields, duplicate tool names and mismatched
server identities. Optional fields absent in legacy pins remain supported;
malformed fields are not treated as absent.

## Explicit limits

The pin store and policy files are administrator-controlled. This is not a
defense against an administrator forging an otherwise valid approval, replacing
the gateway executable, or racing filesystem changes against a running call.
Checks apply before dispatch; already-dispatched work is not retroactively
cancelled when policy or a pin changes.

Missing evidence is remembered for the lifetime of a gateway process after a pin
has been observed or saved. Deleting a pin and starting a new gateway still
triggers the existing trust-on-first-use behavior. `cairn:trust --reapprove`
uses that deliberate next-process workflow. First use is not proof of safety;
operators must review initial servers and secure the approval directory.

An upstream can retain identical metadata while changing its implementation.
Surface pins cannot detect that. Upstream account permissions and OS/container
isolation must enforce actual data access and side-effect limits. Shared upstream
credentials do not establish tenant data isolation. Neither this contract nor
label defanging solves arbitrary semantic prompt injection.

## Release evidence

`security-regressions.yml` independently runs the adversarial, pin and defang
tests, dependency audit and type checking on Node 22 and 24, using a read-only
GitHub token, no persisted checkout credentials and no provider secrets.
Installing dependencies skips lifecycle scripts; the explicit CLI build follows.
These checks supplement the full suite and existing quality guard. A green
security job alone does not authorize release or merge.

Before production claims: obtain a green full CI run on the intended host,
resolve the existing quality regressions and trusted-base review bootstrap,
exercise deployment isolation and load limits, and obtain independent review.
The action versions in this workflow follow the repository's existing v4 tags;
immutable action pinning remains a supply-chain hardening follow-up.
