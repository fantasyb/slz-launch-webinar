import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { execFileSync } from 'child_process';
import { containerTransport } from '../src/lib/cairn/container';

// CI opts in explicitly: an opted-in run must fail, never skip, if Docker fails.
const enabled = process.env.CAIRN_CONTAINER_INTEGRATION === '1';
test('real container denies host access and enforces kernel resource settings and lifetime', { skip: !enabled, timeout: 45000 }, async () => {
  const containers = () => execFileSync('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', 'ps', '-aq', '--filter=label=cairn.isolated=true'], { encoding: 'utf8' }).trim();
  const before = containers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-host-canary-'));
  const hostFile = path.join(dir, 'private');
  fs.writeFileSync(hostFile, 'must stay on host');
  const server = net.createServer((socket) => socket.end('host service'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const previous = process.env.CAIRN_CONTAINER_AMBIENT;
  process.env.CAIRN_CONTAINER_AMBIENT = 'must not inherit';
  let transport: Awaited<ReturnType<typeof containerTransport>> | undefined;
  try {
    transport = await containerTransport({ command: '/usr/local/bin/node', args: ['/probe.mjs', hostFile, String(port)],
      env: { ALLOWED_FIXTURE: 'yes' }, isolation: { image: process.env.CAIRN_CONTAINER_TEST_IMAGE!, maxLifetimeSeconds: 8 } });
    const reported = new Promise<Record<string, unknown>>((resolve, reject) => {
      transport!.onmessage = (m) => { if ('method' in m && m.method === 'containment_probe') resolve(m.params as Record<string, unknown>); };
      transport!.onerror = reject;
    });
    const closed = new Promise<void>((resolve) => { transport!.onclose = resolve; });
    await transport.start();
    const r = await reported;
    assert.equal(r.uid, 65534);
    for (const k of ['hostReadDenied', 'rootWriteDenied', 'dockerSocketDenied', 'ambientAbsent']) assert.equal(r[k], true, k);
    assert.equal(r.explicit, 'yes'); assert.equal(r.scratch, 'scratch');
    assert.equal(r.hostReachable, false); assert.equal(r.externalReachable, false);
    assert.equal(r.memoryMax, String(256 * 1024 * 1024)); assert.equal(r.swapMax, '0');
    assert.equal(r.pidsMax, '32');
    const [quota, period] = String(r.cpuMax).split(' ').map(Number);
    assert.equal(quota / period, 0.5);
    const status = (r.status as string[]).join('\n');
    assert.match(status, /NoNewPrivs:\s+1/); assert.match(status, /Seccomp:\s+2/);
    assert.match(status, /CapEff:\s+0+\b/);
    await closed; // host-side expiry must stop the still-running probe
    await transport.close();
    assert.equal(fs.readFileSync(hostFile, 'utf8'), 'must stay on host');
    assert.equal(containers(), before, 'expiry removes the container, not only the attached client');
  } finally {
    if (transport) await transport.close();
    server.close(); fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CAIRN_CONTAINER_AMBIENT;
    else process.env.CAIRN_CONTAINER_AMBIENT = previous;
  }
});

test('independent supervisor removes an expired container after its gateway process is killed', { skip: !enabled, timeout: 45000 }, async () => {
  const { spawn } = await import('child_process');
  const { reapExpired } = await import('../scripts/container-reaper.mjs');
  const list = () => execFileSync('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', 'ps', '-aq', '--filter=label=cairn.isolated=true'], { encoding: 'utf8' }).trim();
  const before = list();
  const worker = spawn(process.execPath, ['--import', 'tsx', 'fixtures/container/host-worker.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = ''; let err = '';
      worker.stdout.on('data', (b) => { out += String(b); if (out.includes('ready\n')) resolve(); });
      worker.stderr.on('data', (b) => { err += String(b); });
      worker.on('exit', (code) => reject(new Error(`worker exited before ready (${code}): ${err}`)));
      worker.on('error', reject);
    });
    assert.notEqual(list(), before, 'a real container exists before killing the gateway');
    const dead = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    worker.kill('SIGKILL'); await dead;
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.notEqual(list(), before, 'the orphan remains for the independent supervisor to remove');
    assert.ok(reapExpired() >= 1);
    assert.equal(list(), before);
  } finally {
    worker.kill('SIGKILL');
    worker.stdout.destroy(); worker.stderr.destroy();
  }
});
