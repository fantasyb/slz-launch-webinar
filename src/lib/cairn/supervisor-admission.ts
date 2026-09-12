/** Supervisor-side admission core. Not a daemon or a gateway-facing API yet. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { containerPlan, type ContainerSpec } from './container';

interface EvidenceStore {
  assertAdmitted(id: string): void;
  record(id: string): void;
}
interface Limits {
  maxConcurrent: number;
  maxMemoryMiB: number;
  maxCpuMillis: number;
  maxPids: number;
  maxStartsPerMinute: number;
}
interface ApprovedWorkload {
  spec: ContainerSpec;
  maxConcurrent: number;
  memoryMiB: number;
  cpuMillis: number;
  pids: number;
}
export interface AdmissionReservation {
  readonly workload: string;
  readonly quarantineIdentity: string;
  readonly spec: ContainerSpec;
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected a plain object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((k) => !allowed.includes(k))) throw new Error('Unknown supervisor policy or request field');
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid supervisor limit');
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Stable across credentials, arguments, and image changes in one operator catalog.
 * Changing a catalog namespace/ID is a new enrollment, never a gateway choice. */
export function supervisorWorkloadId(namespace: string, workload: string): string {
  if (!ID.test(namespace) || !ID.test(workload)) throw new Error('Invalid approved workload identity');
  return createHash('sha256').update(JSON.stringify(['cairn-supervisor-v1', namespace, workload])).digest('hex');
}

export class SupervisorAdmission {
  private readonly namespace: string;
  private readonly limits: Limits;
  private readonly catalog = new Map<string, ApprovedWorkload>();
  private readonly active = new Map<AdmissionReservation, ApprovedWorkload>();
  private starts: number[] = [];
  private lastTime = -Infinity;
  private ready = false;
  private blocked = false;

  /** Policy and clock are trusted supervisor inputs; only reserve's request is
   * untrusted. Copy policy now so callers cannot mutate approved launch settings. */
  constructor(policy: unknown, private readonly evidence: EvidenceStore, private readonly clock = () => performance.now()) {
    const p = object(policy);
    keys(p, ['version', 'namespace', 'limits', 'workloads']);
    if (p.version !== 1 || typeof p.namespace !== 'string' || !ID.test(p.namespace)) throw new Error('Invalid supervisor policy version or namespace');
    this.namespace = p.namespace;
    const limits = object(p.limits);
    keys(limits, ['maxConcurrent', 'maxMemoryMiB', 'maxCpuMillis', 'maxPids', 'maxStartsPerMinute']);
    this.limits = {
      maxConcurrent: integer(limits.maxConcurrent, 128),
      maxMemoryMiB: integer(limits.maxMemoryMiB, 262144),
      maxCpuMillis: integer(limits.maxCpuMillis, 256000),
      maxPids: integer(limits.maxPids, 16384),
      maxStartsPerMinute: integer(limits.maxStartsPerMinute, 10000),
    };
    const workloads = Object.entries(object(p.workloads));
    if (!workloads.length || workloads.length > 1024) throw new Error('Invalid approved catalog size');
    for (const [id, raw] of workloads) {
      if (!ID.test(id)) throw new Error('Invalid approved workload ID');
      const w = object(raw);
      keys(w, ['spec', 'maxConcurrent']);
      const s = object(w.spec);
      keys(s, ['command', 'args', 'env', 'isolation']);
      const spec = s as ContainerSpec;
      containerPlan(spec); // Reuse the fixed offline profile; never accept runtime flags.
      const copy = freeze(JSON.parse(JSON.stringify(spec)) as ContainerSpec);
      const approved = {
        spec: copy, maxConcurrent: integer(w.maxConcurrent, this.limits.maxConcurrent),
        memoryMiB: copy.isolation!.memoryMiB ?? 256,
        cpuMillis: Math.ceil((copy.isolation!.cpus ?? 0.5) * 1000),
        pids: copy.isolation!.pids ?? 32,
      };
      if (approved.memoryMiB > this.limits.maxMemoryMiB || approved.cpuMillis > this.limits.maxCpuMillis
        || approved.pids > this.limits.maxPids) throw new Error('Approved workload cannot fit aggregate limits');
      this.catalog.set(id, approved);
    }
  }

  /** Supervisor-internal startup gate, NOT a wire operation. The runtime adapter
   * must independently enumerate managed containers and prove absence first.
   * Restart must not silently forget live/orphan resource reservations. */
  activateAfterEmptyRuntimeCheck(managedContainerCount: number): void {
    if (this.ready || this.blocked || managedContainerCount !== 0) throw new Error('Runtime reconciliation required');
    this.ready = true;
  }

  reserve(request: unknown): AdmissionReservation {
    if (!this.ready || this.blocked) throw new Error('Supervisor admission unavailable');
    const r = object(request);
    keys(r, ['workload']);
    if (typeof r.workload !== 'string' || !ID.test(r.workload)) throw new Error('Invalid approved workload request');
    const approved = this.catalog.get(r.workload);
    if (!approved) throw new Error('Workload is not approved');
    const quarantineIdentity = supervisorWorkloadId(this.namespace, r.workload);
    this.evidence.assertAdmitted(quarantineIdentity);
    const now = this.clock();
    if (!Number.isFinite(now) || now < this.lastTime) {
      this.blocked = true;
      throw new Error('Supervisor clock invalid; operator recovery required');
    }
    this.lastTime = now;
    this.starts = this.starts.filter((t) => now - t < 60000);
    let memory = approved.memoryMiB, cpu = approved.cpuMillis, pids = approved.pids, same = 0;
    for (const [lease, used] of this.active) {
      memory += used.memoryMiB; cpu += used.cpuMillis; pids += used.pids;
      if (lease.workload === r.workload) same++;
    }
    if (this.active.size >= this.limits.maxConcurrent || same >= approved.maxConcurrent
      || memory > this.limits.maxMemoryMiB || cpu > this.limits.maxCpuMillis || pids > this.limits.maxPids
      || this.starts.length >= this.limits.maxStartsPerMinute) throw new Error('Supervisor admission limit reached');
    const lease = Object.freeze({ workload: r.workload, quarantineIdentity, spec: approved.spec });
    // Reserve synchronously BEFORE any async Docker operation. Pending launches
    // consume quota too; a failed launch still consumes its start-rate budget.
    this.active.set(lease, approved);
    this.starts.push(now);
    return lease;
  }

  /** Trusted runtime callback only: disconnect/error is NOT proof of removal. */
  confirmRemoved(lease: AdmissionReservation): void {
    if (!this.active.delete(lease)) throw new Error('Unknown or already released reservation');
  }

  /** Quarantine never releases resources. Keep the reservation until the daemon
   * confirms the complete container is gone, or stop all admission on failure. */
  quarantine(lease: AdmissionReservation): void {
    if (!this.active.has(lease)) throw new Error('Unknown reservation');
    try { this.evidence.record(lease.quarantineIdentity); }
    catch (error) { this.blocked = true; throw error; }
  }

  cleanupFailed(): void { this.blocked = true; }
}
