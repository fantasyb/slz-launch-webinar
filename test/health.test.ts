import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const { health, probe } = require('../bin/cairn-health.js');

test('readiness probes the real server without claiming containment or running corpus checks', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-health-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const config = path.join(home, 'claude.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { cairn: {
    command: process.execPath, args: [path.join(process.cwd(), 'bin/cairn-mcp.js')], env: { CAIRN_HOME: home },
  } } }));
  const result = await health({ root: process.cwd(), home, config });
  assert.deepEqual(result, { ready: true, containment: 'not-verified-by-this-check', issues: [] });
  assert.equal(execFileSync(process.execPath, ['bin/cairn-health.js', '--hook', '--home', home, '--claude-json', config], { encoding: 'utf8' }), '', 'healthy automatic check is silent');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { cairn: {
    command: '/untrusted/other-program', args: [path.join(process.cwd(), 'bin/cairn-mcp.js')], env: { CAIRN_HOME: home },
  } } }));
  assert.equal((await health({ root: process.cwd(), home, config })).ready, false, 'wrong executable must not be declared configured');
});

test('bad registration refuses readiness without exposing config contents', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-health-bad-'));
  const config = path.join(home, 'claude.json');
  fs.writeFileSync(config, 'private-token-not-json');
  const result = await health({ root: process.cwd(), home, config });
  assert.equal(result.ready, false);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
});

test('hook reports missing setup but never blocks session startup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-health-hook-'));
  const out = execFileSync(process.execPath, ['bin/cairn-health.js', '--hook', '--home', home, '--claude-json', path.join(home, 'absent')], { encoding: 'utf8' });
  assert.match(out, /Cairn needs attention/);
});

test('unresponsive server is bounded and failed rather than reported ready', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-health-timeout-'));
  const server = path.join(home, 'silent.cjs');
  fs.writeFileSync(server, 'setInterval(() => {}, 1000)');
  assert.equal(await probe(server, home, 100), false);
});
