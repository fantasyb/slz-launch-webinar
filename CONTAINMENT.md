# Restricted upstream execution — experimental

This implementation adds an opt-in Linux Docker execution boundary for local
stdio upstreams. It is not production-attested: this development host has no
Docker or Podman, and its Bubblewrap namespace setup is blocked. Configuration
and refusal tests can run here; actual kernel isolation must pass the dedicated
Docker CI test before this profile is enabled in a deployment.

## Boundary

Set `CAIRN_EXECUTION_MODE=container` and give every upstream a reviewed
`isolation` entry in `--config`. Container mode rejects remote upstream URLs and
missing policies. Host mode rejects entries carrying an isolation policy. There
is no automatic fallback. The ordinary default remains `host` for compatibility.

The fixed runtime profile uses:

| Surface | Restriction |
| --- | --- |
| Image | Immutable SHA-256 image ID or repository digest, already present locally; no runtime pull/build |
| Files | Read-only root filesystem, no host mounts, no image-declared volumes; private 16 MiB temporary directory and 8 MiB shared memory |
| Network | `none`, including isolation from host loopback; no ports, host network or arbitrary runtime options |
| Privilege | UID/GID 65534, all capabilities dropped, no-new-privileges, seccomp required; private cgroup and IPC namespaces |
| Resources | Default 256 MiB RAM, no swap, 0.5 CPU quota, 32 processes/threads, 256 file descriptors, no core dumps |
| Credentials | No ambient gateway credentials; only image defaults and the explicitly declared upstream environment |
| Output | Docker logging disabled; upstream stderr discarded; SDK protocol buffer capped at 1 MiB |
| Lifetime | Default five minutes per upstream process; whole-container removal on close, connect failure or expiry |

An upstream may execute arbitrary code within those bounds. The profile does
not infer safety from tool names, descriptions, model opinions or an upstream's
promise to behave. Approval of advertised capabilities remains a separate layer.

Docker must report Linux cgroup v2 with memory, swap, CPU and PID enforcement and
seccomp. The executable is `/usr/bin/docker`; the only endpoint is the local
`/var/run/docker.sock`. The CLI uses a private empty configuration directory,
not inherited Docker contexts, credential helpers or proxy settings. Declared
upstream environment values travel through a temporary mode-0600 env file rather
than command-line values, and are deleted after container creation. Docker's
administrator can still inspect container environment values.

## Operator setup

Prepare and review a Linux image containing the executable and its dependencies.
It must work without network access, host files, root access or persistent writes.
An image that declares `VOLUME` is rejected. Do not bake production secrets into
an image. Pull/build during the operator's deployment workflow and record the
reviewed immutable image ID or digest.

Example configuration (replace the digest placeholder before use):

```json
{
  "servers": {
    "offline-tool": {
      "command": "/usr/local/bin/node",
      "args": ["/app/server.mjs"],
      "env": { "TOOL_MODE": "offline" },
      "isolation": {
        "image": "registry.example.com/team/server@sha256:REPLACE_WITH_REVIEWED_DIGEST",
        "memoryMiB": 256,
        "cpus": 0.5,
        "pids": 32,
        "maxLifetimeSeconds": 300
      }
    }
  }
}
```

Resource overrides are bounded: memory 64–2048 MiB, CPU 0.1–2, PID/thread count
8–128, lifetime 1–3600 seconds. Unknown isolation options are rejected; the
configuration cannot request host networking, mounts, devices or privileged mode.
Commands are absolute paths inside the image. Command arguments follow the image
reference and cannot become Docker runtime flags.

Combine execution isolation with the independent approval layer:

```sh
CAIRN_HOME=/srv/cairn \
CAIRN_EXECUTION_MODE=container \
CAIRN_TRUST_MODE=enforce \
CAIRN_TRUST_BOOTSTRAP=explicit \
node bin/cairn-proxy.js --config reviewed-containers.json
```

Provision reviewed trust pins separately as described in `SECURITY_MODEL.md`.
The image/configuration and pin store are administrator-controlled. An image
change is a deployment review decision even if its advertised tools stay identical.

## Verification gate

The `container-isolation` CI job builds the disposable fixture, resolves its
immutable image ID, and sets `CAIRN_CONTAINER_INTEGRATION=1`. An opted-in test
fails if Docker or its prerequisites are unavailable; it cannot silently skip.
The probe checks a host-file canary, root write denial, Docker-socket absence,
host-loopback and external network denial, environment separation, non-root UID,
capabilities, seccomp, cgroup limits, private scratch space, and removal after
expiry. The fixture stays alive to distinguish real termination from normal exit. A
second test kills the host worker with SIGKILL, verifies that its container
remains, then invokes the independent reaper and verifies removal.

The ordinary local suite skips this integration test unless explicitly enabled.
That skip is missing deployment evidence, not a successful containment test.
The fixture's Node base tag is for disposable CI build input only; the launcher
receives the resulting immutable image ID. Production images require independent
review and vulnerability management.

## Remaining deployment requirements

- Docker and the host kernel are trusted. This is container isolation, not a
  separate-kernel microVM or an escape-proof boundary. The gateway has access to
  a powerful local Docker service; do not expose that socket to upstreams or
  untrusted gateway extensions. Use a dedicated execution host. A narrower
  supervisor API is a future architectural improvement.
- Lifetime cleanup is enforced by the running gateway. Gateway SIGKILL, host
  crashes, daemon outages or hung cleanup can leave containers behind. Each
  container has `cairn.isolated=true` and an expiry timestamp label. The provided independent host supervisor removes expired containers on a
  30-second timer. Install it before using this profile; it has not been installed
  or exercised here. Cleanup can be delayed by timer scheduling, daemon outages
  or host load, so lifetime is not a hard real-time guarantee. A cleanup error quarantines
  new container launches until operator recovery and gateway restart.
- Limits are per upstream process/container, not per tenant or cumulative usage.
  Reconnects can start another bounded container. Configure host-level aggregate
  quotas and admission limits independently.
- This first profile is offline. SaaS/API upstreams need a separately enforced
  egress broker/allowlist; enabling broad network access would change the threat
  model. No such egress exception is implemented here.
- MCP stdout remains an intentional data channel. Container isolation does not
  solve semantic prompt injection or prevent an upstream from returning data it
  was explicitly given. The gateway's own local tools are outside this upstream
  execution boundary.

Implementation references: Docker's [run controls](https://docs.docker.com/engine/containers/run/),
[resource constraints](https://docs.docker.com/engine/containers/resource_constraints/),
and [seccomp profile](https://docs.docker.com/engine/security/seccomp/).


## Independent supervisor installation

`scripts/container-reaper.mjs` has no application dependencies. It uses the fixed
local Docker endpoint and selects only containers with a valid Cairn name, full
Docker ID, `cairn.isolated=true` label and elapsed `cairn.expires` timestamp.
Malformed or unrelated identities are not removed. Errors exit nonzero for host
monitoring; the next timer run retries. Do not grant upstreams access to Docker
or the supervisor files: labels are not cryptographic ownership evidence.

On the dedicated Linux execution host, install the reviewed script at
`/opt/cairn/scripts/container-reaper.mjs` and the two files from `deploy/systemd`
in `/etc/systemd/system`. Ensure `/usr/bin/node` and `/usr/bin/docker` exist,
files are root-owned and not writable by the gateway identity, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cairn-container-reaper.timer
sudo systemctl start cairn-container-reaper.service
sudo systemctl status cairn-container-reaper.timer
```

The service is independent of the gateway, starts after Docker, and has its own
CPU, memory, process and execution-time limits. Monitor failed service runs and
expired container accumulation. These deployment commands have not been executed
in this session. The kill-and-reap integration test must pass on the target host.
