/** Bundled and run as the restricted gateway OS identity on a disposable runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SupervisorClientTransport } from '../../src/lib/cairn/supervisor-client';

async function main() {
  assert.notEqual(process.getuid?.(), 0);
  const mode = process.argv[2];
  if (mode === 'permissions') {
    assert.throws(() => fs.readFileSync('/etc/cairn/supervisor.json'), /EACCES/);
    assert.throws(() => fs.writeFileSync('/var/lib/cairn-supervisor/forged', 'bad'), /EACCES/);
    assert.throws(() => fs.unlinkSync('/run/cairn-supervisor/control.sock'), /EACCES/);
    for (const target of ['/opt/cairn/dist/cli/container-supervisor.js', '/etc/systemd/system/cairn-supervisor.service', '/usr/bin/node', '/etc/cairn']) {
      assert.throws(() => fs.accessSync(target, fs.constants.W_OK), /EACCES/);
    }
    assert.throws(() => execFileSync('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', 'ps'], { stdio: 'pipe' }));
    const denied = await new Promise<string>((resolve) => {
      const s = net.createConnection('/var/run/docker.sock');
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code!));
      s.once('connect', () => { s.destroy(); resolve('CONNECTED'); });
    });
    assert.equal(denied, 'EACCES');
    console.log('permissions-denied'); return;
  }
  if (mode === 'denied') {
    const transport = new SupervisorClientTransport(process.argv[3]);
    await assert.rejects(transport.start()); await transport.close();
    console.log('launch-denied'); return;
  }
  if (mode === 'fault') {
    const client = new Client({ name: 'fault-probe', version: '1' });
    await assert.rejects(client.connect(new SupervisorClientTransport('hostile')));
    await client.close(); console.log('fault-closed'); return;
  }
  const client = new Client({ name: 'restricted-gateway-probe', version: '1' });
  const transport = new StdioClientTransport({ command: '/usr/bin/node', args: [
    '/opt/cairn/dist/cli/mcp-proxy.js', '--config', '/etc/cairn/gateway.json', '--no-cairn-tools',
  ], env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/cairn-gateway', CAIRN_HOME: '/var/lib/cairn-gateway', CAIRN_EXECUTION_MODE: 'supervisor' }, stderr: 'ignore' });
  if (mode === 'gateway-denied') {
    try { await assert.rejects(client.connect(transport)); }
    finally { await client.close(); await transport.close(); }
    console.log('gateway-refused-without-fallback'); return;
  }
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'echo'));
  assert.deepEqual((await client.callTool({ name: 'echo', arguments: {} })).content, [{ type: 'text', text: 'isolated-echo-ok' }]);
  if (mode === 'hold') {
    console.log(JSON.stringify({ gatewayPid: transport.pid }));
    await new Promise(() => {}); // gateway death closes pipes; no artificial timer
  } else { await client.close(); console.log('gateway-roundtrip-ok'); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
