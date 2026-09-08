/** Restricted Linux container execution. No mounts, network, shell or host fallback. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ContainerQuarantine, workloadId } from './container-quarantine';

const exec = promisify(execFile);
const DOCKER = '/usr/bin/docker';
let cleanupFailure: Error | undefined;
export interface ContainerPolicy {
  image: string;
  memoryMiB?: number;
  cpus?: number;
  pids?: number;
  maxLifetimeSeconds?: number;
}
export interface ContainerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  isolation?: ContainerPolicy;
}
export function executionMode(): 'host' | 'container' | 'supervisor' {
  const mode = process.env.CAIRN_EXECUTION_MODE ?? 'host';
  if (mode !== 'host' && mode !== 'container' && mode !== 'supervisor') throw new Error('CAIRN_EXECUTION_MODE must be host, container, or supervisor');
  return mode;
}
function bound(value: number | undefined, fallback: number, min: number, max: number, integer = true): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error('Invalid container resource limit');
  return n;
}
export function containerPlan(spec: ContainerSpec) {
  const p = spec.isolation;
  if (spec.url || !p || typeof p !== 'object') throw new Error('Container mode requires an isolation policy for each local stdio upstream; remote URLs are unsupported');
  if (Object.keys(p).some((k) => !['image', 'memoryMiB', 'cpus', 'pids', 'maxLifetimeSeconds'].includes(k))) throw new Error('Unknown container isolation option');
  if (typeof p.image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64})$/.test(p.image)) throw new Error('Container image must be pinned by SHA-256, never a mutable tag');
  if (typeof spec.command !== 'string' || !spec.command.startsWith('/') || spec.command.includes('\0')) throw new Error('Container command must be an absolute in-image executable path');
  if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((s) => typeof s !== 'string' || s.includes('\0')))) throw new Error('Invalid container command arguments');
  if (spec.env !== undefined && (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env))) throw new Error('Invalid container environment');
  const environment = Object.entries(spec.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid container environment entry');
    return `${key}=${value}`;
  }).join('\n');
  const memory = bound(p.memoryMiB, 256, 64, 2048);
  return {
    image: p.image, environment,
    lifetime: bound(p.maxLifetimeSeconds, 300, 1, 3600),
    options: ['--network=none', '--cgroupns=private', '--ipc=private', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user=65534:65534', '--init', '--no-healthcheck', '--restart=no', '--log-driver=none',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777', '--shm-size=8m',
      `--memory=${memory}m`, `--memory-swap=${memory}m`, `--cpus=${bound(p.cpus, 0.5, 0.1, 2, false)}`,
      `--pids-limit=${bound(p.pids, 32, 8, 128)}`, '--ulimit=nofile=256:256', '--ulimit=core=0:0',
      '--workdir=/tmp', '--entrypoint', spec.command],
    args: spec.args ?? [],
  };
}

/** Concurrent gateway/reaper cleanup is successful if the daemon confirms absence. */
export async function removeContainer(name: string, run: (args: string[]) => Promise<{ stdout: string }>): Promise<void> {
  if (!/^cairn-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid Cairn container identity');
  try { await run(['rm', '--force', name]); }
  catch (error) {
    // An error string alone cannot distinguish "already removed" from a broken
    // daemon. Ask the live daemon for this exact name before accepting absence.
    const remaining = await run(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]);
    if (remaining.stdout.trim()) throw error;
  }
}

/** Creates first, verifies prerequisites, then attaches. Docker is a trusted host service. */
export async function containerTransport(spec: ContainerSpec, admission?: { quarantine: ContainerQuarantine; identity: string }): Promise<StdioClientTransport> {
  if (cleanupFailure) throw new Error('Container cleanup failed; operator recovery and gateway restart required');
  if (process.platform !== 'linux') throw new Error('Container execution requires a Linux Docker host');
  const plan = containerPlan(spec);
  const quarantine = admission?.quarantine ?? new ContainerQuarantine();
  const identity = admission?.identity ?? workloadId({ image: plan.image, command: spec.command!, args: plan.args });
  quarantine.assertAdmitted(identity);
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-container-'));
  const runtimeEnv = { PATH: '/usr/bin:/bin', HOME: privateDir, DOCKER_CONFIG: privateDir, NODE_ENV: 'production' as const };
  // No inherited DOCKER_HOST/context, credential helpers, proxies or CLI plugins.
  const prefix = ['--host=unix:///var/run/docker.sock'];
  const run = (args: string[]) => exec(DOCKER, [...prefix, ...args], { env: runtimeEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
  const name = `cairn-${randomUUID()}`;
  let created = false;
  try {
    const info = JSON.parse((await run(['info', '--format', '{{json .}}'])).stdout);
    if (info.OSType !== 'linux' || info.CgroupVersion !== '2' || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.PidsLimit
      || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some((s: string) => s.startsWith('name=seccomp,') && !s.includes('unconfined'))) {
      throw new Error('Docker must provide Linux cgroup v2 memory, swap, CPU, PID limits and seccomp');
    }
    // Inspect only: runtime never pulls or builds an unreviewed image.
    const image = JSON.parse((await run(['image', 'inspect', plan.image])).stdout)[0];
    if (image.Os !== 'linux' || Object.keys(image.Config?.Volumes ?? {}).length) throw new Error('Image must be Linux and declare no volumes');
    const envFile = path.join(privateDir, 'upstream.env');
    fs.writeFileSync(envFile, plan.environment, { mode: 0o600 });
    // Mark before create: if the CLI times out after creation, cleanup still runs.
    created = true;
    const expiresAt = Date.now() + plan.lifetime * 1000;
    await run(['create', '--pull=never', '--name', name, '--label=cairn.isolated=true',
      `--label=cairn.expires=${expiresAt}`, '--interactive',
      ...plan.options, '--env-file', envFile, plan.image, ...plan.args]);
    fs.unlinkSync(envFile);
    class IsolatedTransport extends StdioClientTransport {
      private expiry?: NodeJS.Timeout;
      private closing?: Promise<void>;
      private accepting = false;
      private started = false;
      constructor() {
        super({ command: DOCKER, args: [...prefix, 'start', '--attach', '--interactive', name], env: runtimeEnv, stderr: 'ignore', maxBufferSize: 1024 * 1024 });
      }
      async start(): Promise<void> {
        if (this.started || this.closing) throw new Error('Container transport cannot be restarted');
        this.started = true;
        const downstreamMessage = this.onmessage;
        const downstreamError = this.onerror;
        const downstreamClose = this.onclose;
        this.onmessage = (message) => {
          if (!this.accepting) return;
          try { quarantine.assertAdmitted(identity); }
          catch (error) { this.onerror?.(error as Error); return; }
          downstreamMessage?.(message);
        };
        this.onerror = (error) => {
          if (this.accepting) {
            // Revoke synchronously: already-buffered messages after a malformed
            // frame must not reach the client while Docker removal is pending.
            this.accepting = false;
            try { quarantine.record(identity); }
            catch (failure) { cleanupFailure = failure as Error; }
            void this.close().catch((failure: Error) => downstreamError?.(failure));
            downstreamError?.(error);
          }
        };
        this.onclose = () => {
          void this.close().catch((e: Error) => downstreamError?.(e));
          downstreamClose?.();
        };
        try {
          quarantine.assertAdmitted(identity);
          if (Date.now() >= expiresAt) throw new Error('Container lifetime expired before start');
          this.accepting = true;
          await super.start();
          if (this.accepting) {
            this.expiry = setTimeout(() => { void this.close().catch((e: Error) => downstreamError?.(e)); }, Math.max(0, expiresAt - Date.now()));
            this.expiry.unref();
          }
        } catch (e) { await this.close(); throw e; }
      }
      async send(message: Parameters<StdioClientTransport['send']>[0]): Promise<void> {
        if (!this.accepting) throw new Error('Container transport is closed or quarantined');
        try { quarantine.assertAdmitted(identity); }
        catch (error) { this.onerror?.(error as Error); throw error; }
        return super.send(message);
      }
      async close(): Promise<void> {
        this.accepting = false;
        if (!this.closing) this.closing = (async () => {
          clearTimeout(this.expiry);
          try {
            // Remove the whole container, not merely the attached Docker client.
            await removeContainer(name, run);
          } catch (e) {
            cleanupFailure = e as Error;
            throw e;
          } finally {
            await super.close();
            fs.rmSync(privateDir, { recursive: true, force: true });
          }
        })();
        return this.closing;
      }
    }
    return new IsolatedTransport();
  } catch (e) {
    if (created) {
      cleanupFailure = e as Error; // create may have timed out while the daemon was still working
      await removeContainer(name, run).catch((error: Error) => { cleanupFailure = error; });
    }
    fs.rmSync(privateDir, { recursive: true, force: true });
    throw new Error(`Container isolation unavailable; refusing host execution: ${(e as Error).message}`);
  }
}
