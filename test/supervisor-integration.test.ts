import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { supervisorWorkloadId } from '../src/lib/cairn/supervisor-admission';

const enabled = process.env.CAIRN_SUPERVISOR_INTEGRATION === '1';
test('restricted gateway uses the root supervisor but cannot access Docker, policy, recovery, or excess capacity', { skip: !enabled, timeout: 240000 }, async () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid?.(), 0);
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', timeout: 15000 }).trim();
  const systemctl = (...args: string[]) => run('/usr/bin/systemctl', args);
  const containers = () => run('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', 'ps', '-aq', '--filter=label=cairn.isolated=true']);
  const fixtureArgs = (mode: string, ...args: string[]) => ['-u', 'cairn-gateway', '--', '/usr/bin/node', '/opt/cairn/dist/test/supervisor-client.js', mode, ...args];
  const client = async (mode: string, ...args: string[]) => (await promisify(execFile)('/usr/sbin/runuser', fixtureArgs(mode, ...args), { timeout: 25000 })).stdout.trim();
  const until = async (condition: () => boolean, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(condition(), 'condition must hold before deadline');
  };
  assert.equal(containers(), '', 'only run on a disposable empty execution host');
  fs.mkdirSync('/etc/cairn', { recursive: true, mode: 0o755 });
  fs.writeFileSync('/etc/cairn/supervisor.json', JSON.stringify({ version: 1, namespace: 'ci-supervisor',
    limits: { maxConcurrent: 2, maxMemoryMiB: 512, maxCpuMillis: 1000, maxPids: 64, maxStartsPerMinute: 20 },
    workloads: Object.fromEntries(['healthy', 'hostile'].map((id) => [id, { maxConcurrent: 1, spec: {
      command: '/usr/local/bin/node', args: [id === 'healthy' ? '/echo.mjs' : '/hostile.mjs'],
      env: { PRIVATE_FIXTURE: 'operator-only' }, isolation: { image: process.env.CAIRN_CONTAINER_TEST_IMAGE, maxLifetimeSeconds: 30 },
    } }])) }), { mode: 0o600 });
  fs.writeFileSync('/etc/cairn/gateway.json', JSON.stringify({ servers: { echo: { supervisorWorkload: 'healthy' } } }), { mode: 0o644 });
  const held: ReturnType<typeof spawn>[] = [];
  const hold = async () => {
    const child = spawn('/usr/sbin/runuser', fixtureArgs('hold'), { stdio: ['ignore', 'pipe', 'pipe'] });
    held.push(child);
    return new Promise<number>((resolve, reject) => {
      let out = '', err = '';
      const timer = setTimeout(() => reject(new Error(`gateway not ready: ${err}`)), 25000);
      child.stdout!.on('data', (b) => { out += b.toString(); if (out.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(out.trim()).gatewayPid); } });
      child.stderr!.on('data', (b) => { err += b.toString(); });
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${err}`)); });
    });
  };
  try {
    systemctl('start', 'cairn-supervisor.service');
    await until(() => fs.existsSync('/run/cairn-supervisor/control.sock'), 90000);
    assert.equal(await client('permissions'), 'permissions-denied');
    assert.equal(await client('denied', 'not-approved'), 'launch-denied');
    assert.equal(await client('gateway'), 'gateway-roundtrip-ok');
    await until(() => containers() === '');
    const pid = await hold();
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.notEqual(containers(), '');
    assert.equal(await client('denied', 'healthy'), 'launch-denied', 'per-workload cap holds against a separate process');
    // Faulty workload must not take down the healthy gateway's container.
    assert.equal(await client('fault'), 'fault-closed');
    const marker = `/var/lib/cairn-supervisor/quarantine/${supervisorWorkloadId('ci-supervisor', 'hostile')}.json`;
    await until(() => fs.existsSync(marker));
    assert.notEqual(containers(), '');
    assert.equal(await client('denied', 'hostile'), 'launch-denied');
    process.kill(pid, 'SIGKILL'); // the actual gateway Node process, not its wrapper
    await until(() => containers() === '');

    await hold();
    assert.notEqual(containers(), '');
    systemctl('kill', '--signal=SIGKILL', 'cairn-supervisor.service');
    await until(() => !fs.existsSync('/run/cairn-supervisor/control.sock'));
    assert.notEqual(containers(), '', 'supervisor death leaves an orphan for the independent reaper');
    // Restart is an operator action AFTER reconciliation, not an assumption
    // that a 30-second timer plus scheduling delay fits the quiet period.
    // Do not invoke the reaper here; observe the independently installed timer.
    await until(() => containers() === '', 90000);
    systemctl('reset-failed', 'cairn-supervisor.service');
    const restarted = Date.now();
    systemctl('start', 'cairn-supervisor.service');
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(fs.existsSync('/run/cairn-supervisor/control.sock'), false, 'restart cannot refund the rolling launch budget immediately');
    await until(() => fs.existsSync('/run/cairn-supervisor/control.sock'), 90000);
    assert.ok(Date.now() - restarted >= 60000);
    assert.equal(containers(), '', 'reaper removed the orphan before readmission');
    assert.equal(await client('denied', 'hostile'), 'launch-denied', 'stable quarantine survives supervisor restart');
    assert.equal(await client('gateway'), 'gateway-roundtrip-ok');
  } finally {
    systemctl('stop', 'cairn-supervisor.service');
    for (const child of held) { child.kill('SIGTERM'); child.stdout?.destroy(); child.stderr?.destroy(); }
  }
  assert.equal(containers(), '');
  assert.equal(systemctl('show', 'cairn-supervisor.service', '--property=Result', '--value'), 'success');
});
