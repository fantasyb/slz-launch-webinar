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
triggers trust-on-first-use only with the default `CAIRN_TRUST_BOOTSTRAP=tofu`.
The opt-in `explicit` bootstrap below keeps a missing approval blocked across
process restarts. `cairn:trust --reapprove`
uses that deliberate next-process workflow in TOFU mode; explicit mode refuses it. First use is not proof of safety;
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


## Explicit approval: the production admission boundary

Set both `CAIRN_TRUST_MODE=enforce` and `CAIRN_TRUST_BOOTSTRAP=explicit`.
The gateway then never creates or extends approval pins. An unknown server is
withheld on first connection; deleting an approval does not enable it after a
restart. A tools-only approval cannot automatically approve prompts when they
first appear. Unknown bootstrap values and explicit mode paired with monitor or
off refuse startup before upstream connections are established.

Enrollment is a separate operator activity:

1. In a disposable environment with no production credentials, capture a
   candidate pin using the existing monitor/TOFU mode. Request both `tools/list`
   and `prompts/list` to capture both channels. Listing runs upstream code;
   keep this environment isolated. Do not run tools to collect their metadata.
2. Review the candidate JSON, server identity, descriptions, instructions,
   annotations and schema hashes against the intended upstream. Review the raw
   advertised schemas separately: pins contain schema hashes, not full schemas.
   Capture a SHA-256 digest of the exact file that was reviewed.
3. An operator imports those reviewed bytes into the production home:

   ```sh
   CAIRN_HOME=/srv/cairn npm run cairn:trust -- \
     --approve-file /path/to/reviewed-pin.json \
     --server service --sha256 <reviewed-sha256>
   ```

4. Start the gateway with explicit/enforce mode and the same configured server
   name (`service` in this example). Refresh listings after subsequent imports,
   or restart. Use an OS identity that can read approvals but cannot change them
   to enforce separation from the approval-writing operator.

Import validates the digest and the expected server identity before an atomic
write. A rejected import leaves existing approval untouched. The approval date
records the import time. SHA-256 binds content to the supplied digest; it is not
an approver signature or proof that a human reviewed the material. OS access to
the approval command/store remains the authorization boundary.

This mode covers pinned tool/prompt metadata and server instructions. It is not
an OS sandbox, an action-argument capability system, or a policy for every
resource read. A malicious implementation can still lie with unchanged metadata.
The next architectural layer is to constrain actual upstream credentials and
execution, so a gateway mistake has a bounded consequence.


## Container execution follow-up

`CAIRN_EXECUTION_MODE=container` now implements a separate, opt-in offline Linux
Docker profile. Read `CONTAINMENT.md` for the fixed boundary, configuration,
Docker integration gate and remaining deployment requirements. This does not
change the approval contract. Actual isolation has not been exercised on this
host. An independent reaper and systemd units are provided but not installed or
validated here; controlled SaaS egress remains unbuilt.
