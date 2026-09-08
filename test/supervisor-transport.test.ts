import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { SupervisorAdmission } from '../src/lib/cairn/supervisor-admission';
import { SupervisorClientTransport } from '../src/lib/cairn/supervisor-client';
import { serveSupervisor } from '../src/lib/cairn/supervisor-server';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
class Echo implements Transport {
  onmessage?: (m: JSONRPCMessage) => void;
  onerror?: (e: Error) => void;
  onclose?: () => void;
  removed = deferred();
  async start() { this.onmessage?.({ jsonrpc: '2.0', method: 'hello' }); }
  async send(m: JSONRPCMessage) { if ('id' in m) this.onmessage?.({ jsonrpc: '2.0', id: m.id!, result: { ok: true } }); }
  async close() { this.removed.resolve(); this.onclose?.(); }
}
async function fixture(launch: () => Promise<Transport>, maxConcurrent = 2) {
  const dir = fs.mkdtempSync('/tmp/cairn-sup-');
  const socket = `${dir}/s`;
  const admission = new SupervisorAdmission({ version: 1, namespace: 'test',
    limits: { maxConcurrent, maxMemoryMiB: 512, maxCpuMillis: 1000, maxPids: 64, maxStartsPerMinute: 20 },
    workloads: { approved: { maxConcurrent, spec: { command: '/node', args: ['/echo'], isolation: { image: `sha256:${'a'.repeat(64)}` } } } },
  }, { assertAdmitted() {}, record() { throw new Error('Gateway input must not quarantine'); } });
  admission.activateAfterEmptyRuntimeCheck(0);
  const service = await serveSupervisor(socket, admission, { launch });
  return { socket, async close() { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function raw(socketPath: string, data: string) {
  const socket = net.createConnection(socketPath);
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  let output = '';
  socket.on('data', (b) => { output += b.toString(); });
  const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write(data);
  await ended;
  return output;
}

test('supervisor socket handshake precedes early output and relays MCP without launch settings', { timeout: 5000 }, async () => {
  const echo = new Echo(), f = await fixture(async () => echo);
  const client = new SupervisorClientTransport('approved', f.socket);
  try {
    const messages: JSONRPCMessage[] = [];
    const replied = deferred();
    client.onmessage = (m) => { messages.push(m); if ('id' in m) replied.resolve(); };
    await client.start();
    await client.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await replied.promise;
    assert.deepEqual(messages, [{ jsonrpc: '2.0', method: 'hello' }, { jsonrpc: '2.0', id: 1, result: { ok: true } }]);
    assert.equal(fs.statSync(f.socket).mode & 0o777, 0o660);
    await client.close(); await echo.removed.promise;
    await assert.rejects(client.start(), /cannot restart/);
    await assert.rejects(client.send({ jsonrpc: '2.0', method: 'ping' }), /closed/);
  } finally { await client.close(); await f.close(); }
});

test('socket rejects unapproved, malformed, oversized, and authority-bearing opens without launch', { timeout: 5000 }, async () => {
  let launches = 0;
  const f = await fixture(async () => { launches++; return new Echo(); });
  try {
    for (const request of ['not-json\n', '{"workload":"missing"}\n', '{"workload":"approved","command":"/bin/sh"}\n',
      '{"workload":"approved","clearQuarantine":true}\n', 'x'.repeat(4097)]) {
      assert.equal(await raw(f.socket, request), '');
    }
    assert.equal(launches, 0);
  } finally { await f.close(); }
});

test('disconnect during creation still removes the eventual container before refunding quota', { timeout: 5000 }, async () => {
  const creating = deferred(), finishCreate = deferred<Transport>(), echo = new Echo();
  let calls = 0;
  const f = await fixture(async () => { calls++; if (calls === 1) { creating.resolve(); return finishCreate.promise; } return new Echo(); }, 1);
  const peer = net.createConnection(f.socket); peer.on('error', () => {});
  try {
    await new Promise<void>((resolve) => peer.once('connect', resolve));
    peer.write('{"workload":"approved"}\n');
    await creating.promise;
    peer.destroy();
    const denied = new SupervisorClientTransport('approved', f.socket);
    await assert.rejects(denied.start());
    finishCreate.resolve(echo);
    await echo.removed.promise;
    const next = new SupervisorClientTransport('approved', f.socket);
    await next.start(); await next.close();
    assert.equal(calls, 2);
  } finally { peer.destroy(); finishCreate.resolve(echo); await f.close(); }
});

test('malformed gateway traffic closes only its own session and cannot clear or invoke quarantine', { timeout: 5000 }, async () => {
  const f = await fixture(async () => new Echo());
  const healthy = new SupervisorClientTransport('approved', f.socket);
  try {
    await healthy.start();
    const closed = raw(f.socket, '{"workload":"approved"}\n{"workload":"approved","clearQuarantine":true}\n');
    assert.match(await closed, /ready/);
    const reply = deferred(); healthy.onmessage = (m) => { if ('id' in m) reply.resolve(); };
    await healthy.send({ jsonrpc: '2.0', id: 2, method: 'ping' }); await reply.promise;
  } finally { await healthy.close(); await f.close(); }
});

test('uncertain creation blocks further launches and never leaks private runtime errors', { timeout: 5000 }, async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; throw new Error('SECRET_OPERATOR_ARGUMENT'); });
  try {
    assert.equal(await raw(f.socket, '{"workload":"approved"}\n'), '');
    assert.equal(await raw(f.socket, '{"workload":"approved"}\n'), '');
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('cleanup remains reserved until confirmed and failure blocks new admission', { timeout: 5000 }, async () => {
  const cleaning = deferred(), confirm = deferred();
  const echo = new Echo();
  echo.close = async () => { cleaning.resolve(); await confirm.promise; throw new Error('daemon unavailable'); };
  const f = await fixture(async () => echo, 1);
  const client = new SupervisorClientTransport('approved', f.socket);
  try {
    await client.start(); await client.close(); await cleaning.promise;
    assert.equal(await raw(f.socket, '{"workload":"approved"}\n'), '');
    confirm.resolve();
    assert.equal(await raw(f.socket, '{"workload":"approved"}\n'), '');
  } finally { confirm.resolve(); await client.close(); await f.close(); }
});
