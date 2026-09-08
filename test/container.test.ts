import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerPlan, containerTransport, removeContainer, type ContainerSpec } from '../src/lib/cairn/container';
import { baseHome, startProxyExpectingExit } from './helpers/hosted';
import fs from 'fs';
import path from 'path';

const spec: ContainerSpec = { command: '/usr/local/bin/node', args: ['/app/server.js'], isolation: { image: `sha256:${'a'.repeat(64)}` } };
test('container admission rejects attempts to weaken or bypass isolation', () => {
  for (const bad of [
    { ...spec, isolation: undefined }, { ...spec, url: 'https://example.invalid' },
    { ...spec, command: 'node' }, { ...spec, args: ['bad\0arg'] },
    { ...spec, isolation: { image: 'node:latest' } },
    { ...spec, isolation: { ...spec.isolation!, network: 'host' } },
    { ...spec, isolation: { ...spec.isolation!, memoryMiB: 0 } },
    { ...spec, isolation: { ...spec.isolation!, pids: -1 } },
    { ...spec, isolation: { ...spec.isolation!, cpus: Infinity } },
    { ...spec, isolation: { ...spec.isolation!, maxLifetimeSeconds: 0 } },
    { ...spec, env: { KEY: 'value\nINJECTED=yes' } },
  ]) assert.throws(() => containerPlan(bad), JSON.stringify(bad));
});

test('container plan separates arguments and credentials from runtime flags', () => {
  const result = containerPlan({ ...spec, args: ['--privileged', '--mount=type=bind,src=/,dst=/host'], env: { ONLY_EXPLICIT: 'yes' } });
  assert.deepEqual(result.args, ['--privileged', '--mount=type=bind,src=/,dst=/host']);
  assert.equal(result.environment, 'ONLY_EXPLICIT=yes');
  assert.ok(result.options.includes('--network=none'));
  assert.ok(result.options.includes('--read-only'));
  assert.ok(!result.options.some((s) => s.startsWith('--mount') || s === '--privileged'));
  assert.ok(result.options.includes('--memory-swap=256m'));
  assert.ok(result.options.includes('--pids-limit=32'));
});

test('gateway refuses container configuration mistakes before launching host code', async () => {
  const home = baseHome('cairn-container-refusal-');
  const marker = path.join(home, 'executed');
  const file = path.join(home, 'servers.json');
  try {
    for (const [mode, entry] of [
      ['container', { command: '/bin/sh', args: ['-c', `touch ${marker}`] }],
      ['host', { ...spec, command: '/bin/sh', args: ['-c', `touch ${marker}`] }],
      ['contaner', spec],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify({ servers: { isolated: entry } }));
      const result = await startProxyExpectingExit(home, { CAIRN_EXECUTION_MODE: mode }, ['--config', file]);
      assert.notEqual(result.code, 0, result.stderr);
      assert.equal(fs.existsSync(marker), false, 'host execution must never be a fallback');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('missing runtime or missing pinned image refuses execution without a fallback', async () => {
  await assert.rejects(containerTransport(spec), /refusing host execution|requires a Linux/);
});


test('concurrent cleanup accepts proven absence but rejects a live orphan or unreachable daemon', async () => {
  const name = 'cairn-11111111-1111-4111-8111-111111111111';
  await removeContainer(name, async (args) => {
    if (args[0] === 'rm') throw new Error('already removed');
    assert.deepEqual(args, ['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]);
    return { stdout: '' };
  });
  await assert.rejects(removeContainer(name, async (args) => {
    if (args[0] === 'rm') throw new Error('removal failed');
    return { stdout: 'still-present' };
  }), /removal failed/);
  await assert.rejects(removeContainer(name, async () => { throw new Error('daemon unavailable'); }), /daemon unavailable/);
});
