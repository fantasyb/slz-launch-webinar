# Narrow execution supervisor — experimental

## Current status

The separate service, bounded Unix-socket transport, runtime adapter, and gateway
client are implemented. `CAIRN_EXECUTION_MODE=supervisor` selects this path;
ordinary host mode and legacy direct-container mode remain compatibility options.
The production OS permissions are essential: changing the mode alone does not
remove Docker authority from an account that already has it. Real Linux CI tests
exercise a separately provisioned gateway account; target-host verification is
still required. Nothing here automatically deploys production services.

The opening wire request contains only `{ "workload": "approved-id" }`.
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
- Every service start waits a full 60 seconds before reconciliation and listening,
  preventing a restart from refunding the previous rolling start-rate budget.
- One socket connection owns one launch; closing it removes that container. No
  caller-selected session handles exist. Disconnect during creation still awaits
  creation and cleans up the result. Uncertain creation blocks further admission.
- Opens are bounded to 4 KiB and two seconds, creation to a 60-second client wait,
  frames to 1 MiB, and each direction to 16 MiB / 10,000 frames per session. At
  most 64 connections are handled. Sequential reads apply backpressure; queued
  output is bounded to 1 MiB. Exceeding a wire budget closes the session.
- Malformed gateway traffic closes only its session, without manufacturing an
  upstream quarantine. The container runtime independently detects upstream faults
  and persists quarantine under the stable operator workload identity.

The constructor, reconciliation callback, removal callback, and quarantine methods
are supervisor-internal. They must never be exposed directly as wire operations.
The reservation includes the private launch specification and may contain secrets;
it must never be serialized to the gateway. Only the runtime adapter may use it.

## What is automatic today?

| Behavior | Current automation |
| --- | --- |
| Container isolation and fixed restrictions | Automatic in explicitly configured container or supervisor mode; not the host-mode default |
| Transport-fault revocation, quarantine, container removal | Automatic in those isolated paths |
| Whole-container expiry | Automatic while the owning container launcher is running |
| Orphan removal after gateway death | Automatic only after the independent reaper timer is installed and enabled on the execution host |
| Real Docker/systemd regression tests | Automatic in the dedicated CI workflow; not proof of production installation |
| Clearing quarantine or approving new executable settings | Operator-controlled; no automatic readmission |
| Installing production controls or removing gateway Docker permissions | Not performed automatically by this change |
| Supervisor admission and quotas | Automatic only in supervisor mode with the separate service installed |

## Operator installation contract

Use a dedicated Linux execution host satisfying `CONTAINMENT.md`. Build reviewed
code with `npm run cairn:build-cli`; install `dist/cli/container-supervisor.js` at
`/opt/cairn/dist/cli/container-supervisor.js`, with root-owned, non-gateway-writable
ancestors and executable dependencies. The unit expects `/usr/bin/node` and
`/usr/bin/docker`. Install `deploy/systemd/cairn-supervisor.service` in
`/etc/systemd/system`. Keep the separate reaper timer installed and monitored.

Provision a `cairn-gateway` group/account without Docker membership, sudo, Polkit
service-management permission, or write access to supervisor code/config/state.
The service runs as root with that group solely to grant access to its mode-0660
socket at `/run/cairn-supervisor/control.sock`. Its runtime directory is mode 0750;
gateway group members cannot replace the socket. Durable state is mode 0700 under
`/var/lib/cairn-supervisor`. Gateway processes must not run as root. Use host-level
limits for the gateway itself as well as the provided supervisor service limits.

Place the catalog at `/etc/cairn/supervisor.json`, root-owned mode 0600, with
root-owned ancestors that are not group/world-writable and contain no symlinks:

```json
{
  "version": 1,
  "namespace": "execution-host",
  "limits": { "maxConcurrent": 2, "maxMemoryMiB": 512, "maxCpuMillis": 1000, "maxPids": 64, "maxStartsPerMinute": 10 },
  "workloads": {
    "offline-tool": {
      "maxConcurrent": 1,
      "spec": {
        "command": "/usr/local/bin/node",
        "args": ["/app/server.mjs"],
        "isolation": { "image": "sha256:REPLACE_WITH_REVIEWED_IMAGE_ID", "maxLifetimeSeconds": 300 }
      }
    }
  }
}
```

The gateway's separate configuration contains no launch settings:

```json
{ "servers": { "offline": { "supervisorWorkload": "offline-tool" } } }
```

Start the reviewed service using systemd and wait for its socket before starting
the gateway with `CAIRN_EXECUTION_MODE=supervisor`, plus the separate explicit trust
enrollment settings described in `CONTAINMENT.md`. Missing services, unknown IDs,
and mixed configurations refuse execution; there is no Docker/host fallback.
Supervisor admission approves execution, not the meaning of MCP responses.
When migrating from direct-container mode, reconcile its existing quarantine
markers explicitly before enrolling the stable catalog IDs. The old hash-based
store is not automatically imported into the supervisor's separate root-owned
state; changing execution mode must not be treated as an implicit readmission.

Service restarts are not automatically retried after failure. Existing containers,
uncertain cleanup, unsafe ownership, stale socket/config state, or failed runtime
checks require operator reconciliation. No gateway-accessible recovery endpoint
exists. Quarantine files require reviewed operator recovery; an audited recovery
tool and richer operational telemetry remain future work. Record manual recovery
in the operator's audit process. Never clear evidence merely to make a restart pass.
The service uses `KillMode=mixed`: graceful stop signals the supervisor first so
its removal helpers can complete, with whole-group termination on timeout. A
cleanup failure must result in a failed service exit, not a successful shutdown.

## Verification and limits

The dedicated CI job installs the shipped service on a disposable Linux runner
and runs `test/supervisor-integration.test.ts` with
`CAIRN_SUPERVISOR_INTEGRATION=1` as root. It launches the actual gateway under an
unprivileged account, exercises an approved tool, requires Docker/policy/state
access denial, checks cross-process quota and quarantine, kills the actual gateway,
then kills/restarts the supervisor and checks cooldown, reaper cleanup, and durable
denial. This test writes fixed system paths: never opt into it on a shared or
production host. Missing prerequisites must fail, not skip, when explicitly enabled.

The local socket tests use a fake runtime to exercise protocol/admission races;
they are not a substitute for the real Docker and OS-identity test. Verify the
exact revision's CI and then the target host before relying on this boundary.
Catalog IDs and quotas are shared by all clients authorized for this socket;
this is not per-tenant authentication. A compromised gateway can still call
approved tools, consume its allowed resources, or attempt denial of service.

The supervisor will remain a trusted privileged component. A gateway compromise
could still exercise approved capabilities or attempt denial of service; the goal
is a bounded execution authority, not an indestructible process or universal
malicious-content detector.
