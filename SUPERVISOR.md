# Narrow execution supervisor — staged implementation

## Current status

`src/lib/cairn/supervisor-admission.ts` is a tested admission core, not a running
privileged service. It is deliberately not connected to the gateway yet. The
existing opt-in container execution path still gives the gateway Docker access.
Do not treat this module or passing unit tests as proof of privilege separation.

The future gateway request contains only `{ "workload": "approved-id" }`.
The operator owns a versioned catalog containing fixed image, command, arguments,
explicit environment, lifetime, resource settings, and per-workload concurrency.
There is no caller-supplied command, environment, image, mount, network option,
quarantine-clear operation, or arbitrary container ID.

## Implemented admission invariants

- Unknown fields, unknown workload IDs, invalid limits, and weakened container
  profiles are refused. Approved settings are copied and recursively frozen.
- Pending launches count against aggregate concurrent, memory, CPU, and PID
  limits. Reservations are synchronous, before asynchronous runtime operations.
- Per-workload concurrency and a rolling start-rate limit apply separately.
  Removal or failed launch does not refund the start-rate budget.
- A reservation is released only by the trusted runtime adapter after confirmed
  removal (or confirmed absence following failed creation). Errors/disconnects
  alone do not release resources. Duplicate or forged reservations cannot release.
- Stable quarantine identity binds the operator namespace and workload ID, not
  mutable arguments, image, or secrets. Updating catalog contents does not clear
  quarantine. Changing an ID/namespace is a distinct operator enrollment.
- Quarantine persistence failure, cleanup failure, or clock rollback blocks new
  admission. Quarantine does not release a container's resource reservation.
- A new admission instance is disabled until the trusted runtime adapter proves
  that no managed containers remain. Supervisor restart must not forget orphans.

The constructor, reconciliation callback, removal callback, and quarantine methods
are supervisor-internal. They must never be exposed directly as wire operations.
The reservation includes the private launch specification and may contain secrets;
it must never be serialized to the gateway. Only the runtime adapter may use it.

## What is automatic today?

| Behavior | Current automation |
| --- | --- |
| Container isolation and fixed restrictions | Automatic for upstreams explicitly configured in container mode; not the host-mode default |
| Transport-fault revocation, quarantine, container removal | Automatic in that container path |
| Whole-container expiry while gateway runs | Automatic in that container path |
| Orphan removal after gateway death | Automatic only after the independent reaper timer is installed and enabled on the execution host |
| Real Docker/systemd regression tests | Automatic in the dedicated CI workflow; not proof of production installation |
| Clearing quarantine or approving new executable settings | Operator-controlled; no automatic readmission |
| Installing production controls or removing gateway Docker permissions | Not performed automatically by this change |
| New supervisor admission core | Unit-tested foundation only; not active in the gateway |

## Required next stages before enabling a supervisor mode

1. Implement a small local socket service and bounded protocol. Authenticate the
   gateway through OS identities/socket permissions. Accept only approved IDs;
   bind each session to its connection and limit handshakes, bytes, connections,
   and backpressure. No gateway-selected recovery operation or private spec output.
2. Wire the trusted runtime adapter: use stable quarantine IDs throughout launch
   and transport faults; reserve before create; keep capacity until daemon-confirmed
   absence; reconcile orphans at startup; refuse uncertainty. The current module's
   in-memory start-rate window must be persisted or protected by a conservative
   restart cooldown before claiming a restart-resistant launch-rate bound.
3. Install root-owned policy, executable, and durable state outside gateway-writeable
   paths. Run the gateway under a separate identity without Docker group membership,
   Docker socket access, supervisor-state access, or permission to restart/modify
   the supervisor. Keep the independently scheduled reaper.
4. Add the gateway client with explicit supervisor mode and no direct-Docker/host
   fallback. Reject mixed launch configuration rather than quietly ignoring it.
5. Run real Linux tests from the gateway's restricted OS identity: arbitrary
   commands rejected, Docker unavailable, quotas enforced under concurrent pending
   launches, quarantine cannot be cleared, another connection cannot control a
   session, gateway/supervisor death handled, and healthy workloads preserved.
6. Verify that exact deployment on the production host and exercise an audited
   operator recovery procedure before relying on the new boundary.

The supervisor will remain a trusted privileged component. A gateway compromise
could still exercise approved capabilities or attempt denial of service; the goal
is a bounded execution authority, not an indestructible process or universal
malicious-content detector.
