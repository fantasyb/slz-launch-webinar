/** Fixed-path production entrypoint. Install outside gateway-writable paths. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContainerQuarantine } from '../src/lib/cairn/container-quarantine';
import { containerTransport } from '../src/lib/cairn/container';
import { SupervisorAdmission } from '../src/lib/cairn/supervisor-admission';
import { serveSupervisor } from '../src/lib/cairn/supervisor-server';
import { SUPERVISOR_SOCKET } from '../src/lib/cairn/supervisor-wire';

const POLICY = '/etc/cairn/supervisor.json';
const STATE = '/var/lib/cairn-supervisor';
let phase = 'configuration';

function rootOwned(target: string): void {
  for (let current = target;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unsafe supervisor ownership or permissions');
    if (current === '/') break;
  }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error('Supervisor requires the fixed Linux root service entrypoint');
  process.umask(0o077);
  rootOwned(POLICY); rootOwned(STATE); rootOwned(path.dirname(SUPERVISOR_SOCKET));
  const stat = fs.statSync(POLICY);
  if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077)) throw new Error('Supervisor policy must be a private bounded regular file');
  const quarantine = new ContainerQuarantine(path.join(STATE, 'quarantine'));
  // The admission constructor validates and snapshots the catalog before the
  // service accepts any client. No config reload or gateway-selected policy.
  const admission = new SupervisorAdmission(JSON.parse(fs.readFileSync(POLICY, 'utf8')), quarantine);
  const dockerConfig = path.join(STATE, 'docker');
  fs.mkdirSync(dockerConfig, { mode: 0o700 }); // Existing unexpected config fails closed.
  try {
    // A full quiet window on EVERY process start prevents restart from refunding
    // the previous process's rolling start budget. No env/CLI skip switch.
    phase = 'startup quiet period';
    await new Promise((resolve) => setTimeout(resolve, 60000));
    phase = 'runtime enumeration';
    const { stdout } = await promisify(execFile)('/usr/bin/docker', [
      '--host=unix:///var/run/docker.sock', 'ps', '-aq', '--filter=label=cairn.isolated=true',
    ], { timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: dockerConfig, DOCKER_CONFIG: dockerConfig, NODE_ENV: 'production' } });
    phase = 'empty-runtime reconciliation';
    admission.activateAfterEmptyRuntimeCheck(stdout.trim() ? stdout.trim().split(/\s+/).length : 0);
  } finally { fs.rmdirSync(dockerConfig); }
  phase = 'socket binding';
  const service = await serveSupervisor(SUPERVISOR_SOCKET, admission, {
    launch: (lease) => containerTransport(lease.spec, { quarantine, identity: lease.quarantineIdentity }),
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  console.error('cairn supervisor ready');
}

main().catch(() => { console.error(`cairn supervisor startup refused during ${phase}; operator reconciliation required`); process.exitCode = 1; });
