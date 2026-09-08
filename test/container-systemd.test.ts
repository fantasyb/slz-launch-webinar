import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const enabled = process.env.CAIRN_CONTAINER_SYSTEMD_INTEGRATION === '1';
test('installed systemd timer reaps an orphan without the gateway or a direct reaper invocation', { skip: !enabled, timeout: 90000 }, async () => {
  const docker = (...args: string[]) => execFileSync('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', ...args], { encoding: 'utf8', timeout: 15000 }).trim();
  const systemctl = (...args: string[]) => execFileSync('systemctl', args, { encoding: 'utf8', timeout: 15000 }).trim();
  assert.equal(systemctl('is-active', 'cairn-container-reaper.timer'), 'active');
  const list = () => docker('ps', '-aq', '--no-trunc', '--filter=label=cairn.isolated=true').split(/\s+/).filter(Boolean);
  const before = new Set(list());
  const worker = spawn(process.execPath, ['--import', 'tsx', 'fixtures/container/host-worker.ts'], {
    env: { ...process.env, CAIRN_CONTAINER_WORKER_LIFETIME: '8' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let orphan: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let out = '', err = '';
      const timeout = setTimeout(() => reject(new Error(`worker did not become ready: ${err}`)), 15000);
      worker.stdout.on('data', (b) => { out += String(b); if (out.includes('ready\n')) { clearTimeout(timeout); resolve(); } });
      worker.stderr.on('data', (b) => { err += String(b); });
      worker.once('error', (e) => { clearTimeout(timeout); reject(e); });
      worker.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`worker exited ${code}: ${err}`)); });
    });
    const created = list().filter((id) => !before.has(id));
    assert.equal(created.length, 1);
    orphan = created[0];
    const dead = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    worker.kill('SIGKILL'); await dead;
    assert.ok(list().includes(orphan), 'a live orphan must exist after the gateway dies');
    const deadline = Date.now() + 65000;
    while (list().includes(orphan) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!list().includes(orphan), 'the installed timer must remove the expired orphan');
    while (systemctl('show', 'cairn-container-reaper.service', '--property=ActiveState', '--value') === 'activating' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(systemctl('show', 'cairn-container-reaper.service', '--property=ActiveState', '--value'), 'inactive');
    assert.equal(systemctl('show', 'cairn-container-reaper.service', '--property=Result', '--value'), 'success');
    assert.equal(systemctl('show', 'cairn-container-reaper.service', '--property=ExecMainStatus', '--value'), '0');
  } finally {
    worker.kill('SIGKILL'); worker.stdout.destroy(); worker.stderr.destroy();
    if (orphan && list().includes(orphan)) docker('rm', '--force', orphan);
  }
});
