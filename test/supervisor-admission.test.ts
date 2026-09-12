import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorAdmission, supervisorWorkloadId } from '../src/lib/cairn/supervisor-admission';
import { ContainerQuarantine } from '../src/lib/cairn/container-quarantine';

function policy() {
  const workload = () => ({ maxConcurrent: 2, spec: {
    command: '/usr/local/bin/node', args: ['/server.mjs'], env: { TOKEN: 'operator-owned' },
    isolation: { image: `sha256:${'a'.repeat(64)}`, memoryMiB: 256, cpus: 0.5, pids: 32 },
  } });
  return { version: 1, namespace: 'execution-host',
    limits: { maxConcurrent: 4, maxMemoryMiB: 1024, maxCpuMillis: 2000, maxPids: 128, maxStartsPerMinute: 10 },
    workloads: { first: workload(), second: workload() },
  };
}
function evidence() {
  const denied = new Set<string>();
  return { assertAdmitted: (id: string) => { if (denied.has(id)) throw new Error('quarantined'); }, record: (id: string) => { denied.add(id); } };
}
function admission(p = policy(), store = evidence(), clock?: () => number) {
  const a = new SupervisorAdmission(p, store, clock);
  a.activateAfterEmptyRuntimeCheck(0);
  return a;
}

test('supervisor accepts only an approved ID, never caller-supplied launch authority', () => {
  const a = admission();
  for (const request of [null, [], 'first', {}, { workload: 'unknown' }, { workload: '../first' },
    { workload: 'first', command: '/bin/sh' }, { workload: 'first', args: ['--privileged'] },
    { workload: 'first', env: { TOKEN: 'attacker' } }, { workload: 'first', image: 'alpine:latest' },
    { workload: 'first', mounts: ['/'] }, { workload: 'first', clearQuarantine: true },
    { workload: 'first', maxLifetimeSeconds: 360000 },
  ]) assert.throws(() => a.reserve(request), JSON.stringify(request));
  assert.equal(a.reserve({ workload: 'first' }).spec.command, '/usr/local/bin/node');
});

test('approved launch settings are copied and recursively frozen', () => {
  const p = policy(), a = admission(p);
  p.workloads.first.spec.args.push('--unreviewed');
  p.workloads.first.spec.env.TOKEN = 'changed';
  p.limits.maxConcurrent = 128;
  const lease = a.reserve({ workload: 'first' });
  assert.deepEqual(lease.spec.args, ['/server.mjs']);
  assert.equal(lease.spec.env!.TOKEN, 'operator-owned');
  assert.ok(Object.isFrozen(lease));
  assert.ok(Object.isFrozen(lease.spec));
  assert.ok(Object.isFrozen(lease.spec.args));
  assert.ok(Object.isFrozen(lease.spec.isolation));
  assert.throws(() => lease.spec.args!.push('--privileged'));
});

test('operator catalog rejects weakened profiles, misspelled fields, and impossible limits', () => {
  const cases: unknown[] = [
    { ...policy(), version: 2 }, { ...policy(), namespace: '../other' },
    { ...policy(), limits: { ...policy().limits, maxConcurrent: 0 } },
    { ...policy(), limits: { ...policy().limits, maxCpuMillis: 499 } },
    { ...policy(), limits: { ...policy().limits, maxPids: Infinity } },
    { ...policy(), workloads: {} }, { ...policy(), maxConcurent: 500 },
  ];
  for (const extra of [{ url: 'https://remote.invalid' }, { network: 'host' }, { command: '/bin/sh', isolation: undefined },
    { isolation: { image: 'node:latest' } }, { isolation: { ...policy().workloads.first.spec.isolation, privileged: true } }]) {
    cases.push({ ...policy(), workloads: { first: { ...policy().workloads.first, spec: { ...policy().workloads.first.spec, ...extra } } } });
  }
  for (const p of cases) assert.throws(() => new SupervisorAdmission(p, evidence()));
});

test('admission is disabled until trusted startup reconciles runtime absence', () => {
  const a = new SupervisorAdmission(policy(), evidence());
  assert.throws(() => a.reserve({ workload: 'first' }), /unavailable/);
  for (const count of [1, -1, NaN, Infinity]) assert.throws(() => a.activateAfterEmptyRuntimeCheck(count), /reconciliation/);
  a.activateAfterEmptyRuntimeCheck(0);
  a.reserve({ workload: 'first' });
  assert.throws(() => a.activateAfterEmptyRuntimeCheck(0), /reconciliation/);
});

test('concurrent pending launch reservations cannot oversubscribe aggregate resources', async () => {
  for (const resource of ['maxConcurrent', 'maxMemoryMiB', 'maxCpuMillis', 'maxPids'] as const) {
    const p = policy();
    p.limits[resource] = { maxConcurrent: 2, maxMemoryMiB: 512, maxCpuMillis: 1000, maxPids: 64 }[resource];
    const a = admission(p);
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => Promise.resolve().then(() =>
      a.reserve({ workload: i % 2 ? 'first' : 'second' }))));
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 2, resource);
    assert.equal(attempts.filter((r) => r.status === 'rejected').length, 28, resource);
  }
});

test('per-workload cap, exact release, and double-release rejection preserve reservations', () => {
  const a = admission();
  const first = a.reserve({ workload: 'first' });
  a.reserve({ workload: 'first' });
  assert.throws(() => a.reserve({ workload: 'first' }), /limit/);
  a.reserve({ workload: 'second' }); // unrelated approved work is still admitted
  assert.throws(() => a.confirmRemoved({ ...first }), /Unknown/);
  assert.throws(() => a.reserve({ workload: 'first' }), /limit/);
  a.confirmRemoved(first);
  assert.throws(() => a.confirmRemoved(first), /released/);
  a.reserve({ workload: 'first' });
});

test('release does not refund the launch-rate budget, and clock rollback fails closed', () => {
  const p = policy(); p.limits.maxStartsPerMinute = 1;
  let now = 100;
  const a = admission(p, evidence(), () => now);
  a.confirmRemoved(a.reserve({ workload: 'first' }));
  assert.throws(() => a.reserve({ workload: 'second' }), /limit/);
  now += 59999;
  assert.throws(() => a.reserve({ workload: 'second' }), /limit/);
  now++;
  a.confirmRemoved(a.reserve({ workload: 'second' }));
  now--;
  assert.throws(() => a.reserve({ workload: 'first' }), /clock/);
  now += 60001;
  assert.throws(() => a.reserve({ workload: 'first' }), /unavailable/);
});

test('quarantine remains across supervisor reconstruction and changed args, credentials, or image', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-supervisor-admission-'));
  try {
    const store = new ContainerQuarantine(dir);
    const a = new SupervisorAdmission(policy(), store);
    a.activateAfterEmptyRuntimeCheck(0);
    const lease = a.reserve({ workload: 'first' });
    a.quarantine(lease);
    a.confirmRemoved(lease);
    const p = policy();
    p.workloads.first.spec.args.push('new-nonce');
    p.workloads.first.spec.env.TOKEN = 'rotated';
    p.workloads.first.spec.isolation.image = `sha256:${'b'.repeat(64)}`;
    const restarted = new SupervisorAdmission(p, new ContainerQuarantine(dir));
    restarted.activateAfterEmptyRuntimeCheck(0);
    assert.throws(() => restarted.reserve({ workload: 'first' }), /quarantined/);
    restarted.reserve({ workload: 'second' });
    assert.notEqual(supervisorWorkloadId('execution-host', 'first'), supervisorWorkloadId('other-host', 'first'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quarantine does not release quota; persistence and cleanup failures stop new admission', () => {
  const p = policy(); p.limits.maxConcurrent = 2;
  const a = admission(p), lease = a.reserve({ workload: 'first' });
  a.reserve({ workload: 'second' });
  a.quarantine(lease);
  assert.throws(() => a.reserve({ workload: 'second' }), /limit/);
  a.confirmRemoved(lease);
  a.reserve({ workload: 'second' });
  a.cleanupFailed();
  assert.throws(() => a.reserve({ workload: 'first' }), /unavailable/);
  const b = admission(policy(), { assertAdmitted() {}, record() { throw new Error('disk failure'); } });
  assert.throws(() => b.quarantine(b.reserve({ workload: 'first' })), /disk failure/);
  assert.throws(() => b.reserve({ workload: 'second' }), /unavailable/);
});
