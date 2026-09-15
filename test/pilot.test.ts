import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pilotSummary, sharePilotReport } from '../src/lib/cairn/pilot';
import type { RetrievalRecord } from '../src/lib/cairn/ledger';
import { gatewaySetup } from '../bin/cairn-health.js';

const ROOT = process.cwd();

test('pilot counts transport facts separately from annotations and excludes non-gateway/old traffic', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const row = (source: string, extra: Partial<RetrievalRecord> = {}): RetrievalRecord => ({ at: new Date(now).toISOString(), by: 'private-person', query: 'sensitive-query', returned: [], source, ...extra });
  const call = row('mcp-proxy:call', { call: { id: 'call-1', server: 'private-server', tool: 'private-tool', elapsedMs: 20, status: 'tool-success' } });
  const rows = [call, call, row('mcp-proxy:error'), row('cli:find'),
    row('mcp-proxy:call', { at: '2020-01-01T00:00:00Z' }),
    row('mcp-proxy:result', { matchedBy: 'tool' }), row('mcp-proxy:result', { matchedBy: 'result-signature' }),
    row('mcp-proxy:result'), row('mcp-proxy:autowrite')];
  const summary = pilotSummary(rows, [{ name: 'private-server', state: 'wrapped', reason: 'configured', autowrite: true }], 7, now);
  assert.equal(summary.calls, 2, 'one new call, one legacy; duplicate IDs excluded');
  assert.equal(summary.legacyCalls, 1);
  assert.equal(summary.resultAnnotations, 3);
  assert.equal(summary.resultPatternMatches, 1);
  assert.equal(summary.broadToolMatches, 1);
  assert.equal(summary.unknownMatchReason, 1);
  assert.equal(summary.connections[0].p95CallMs, 20);
  assert.equal(summary.taskOutcomes, 'not-measured');
  const shared = JSON.stringify(sharePilotReport(summary));
  for (const value of ['private-server', 'private-tool', 'private-person', 'sensitive-query', 'call-1']) assert.ok(!shared.includes(value), `export leaked ${value}`);
  assert.ok(shared.includes('connection-1'));
});

test('installed Stop hook flushes both idle gateways; pilot report sees real traffic without exposing payloads', { timeout: 30_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-pilot-'));
  const corpus = path.join(home, 'my corpus');
  const config = path.join(home, '.claude.json');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }));
  const server = { command: process.execPath, args: [path.join(ROOT, 'fixtures/mcp/upstream.mjs'), '--lie-shapes'] };
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { left: server, right: server, oauth: { url: 'https://private.example/mcp' } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CAIRN_HOME; delete env.CAIRN_EVAL; delete env.CAIRN_AUTOWRITE;
  const install = () => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/install-global.ts', '--home', corpus, '--autowrite', '--no-daemon'], { cwd: ROOT, env, encoding: 'utf8' });
  install(); install();
  const installed = JSON.parse(fs.readFileSync(config, 'utf8')).mcpServers;
  const hooks = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks);
  assert.equal(hooks.filter((h: { command: string }) => h.command.includes('cairn-flush.js')).length, 1);
  assert.ok(hooks.some((h: { command: string }) => h.command === 'echo user-hook'));
  const hook = hooks.find((h: { command: string }) => h.command.includes('cairn-flush.js')).command;
  const clients: Client[] = [];
  t.after(async () => { await Promise.allSettled(clients.map((c) => c.close())); fs.rmSync(home, { recursive: true, force: true }); });
  for (const name of ['left', 'right']) {
    const entry = installed[name];
    const client = new Client({ name: `pilot-${name}`, version: '1' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args,
      env: { ...env, ...entry.env }, stderr: 'pipe' }));
  }
  await clients[0].callTool({ name: 'mcp__data360__search_code', arguments: { q: 'private-query-value' } });
  await clients[1].callTool({ name: 'mcp__data360__get_file_contents', arguments: { path: 'package.json' } });
  const findings = () => fs.readdirSync(path.join(corpus, 'cairn')).filter((f) => f.endsWith('.json'));
  assert.equal(findings().length, 0);
  assert.equal(execFileSync('/bin/sh', ['-c', hook], { env, encoding: 'utf8' }), '', 'Stop has no model output');
  const deadline = Date.now() + 10_000;
  while (findings().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(findings().length, 2, 'both gateways flush without another tool request');
  assert.ok(fs.existsSync(path.join(corpus, 'data', 'flush-signal')), 'broadcast remains for every gateway');
  const statuses = gatewaySetup({ root: ROOT, home: corpus, config });
  assert.deepEqual(statuses.map((s) => s.state), ['wrapped', 'wrapped', 'direct']);
  const out = execFileSync(process.execPath, ['bin/cairn-pilot.js', '--claude-json', config, '--json'], { cwd: ROOT, env, encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.setup.gatewayReady, true);
  assert.equal(report.summary.calls, 2);
  assert.deepEqual(report.summary.connections.map((c: { calls: number }) => c.calls), [1, 1, 0]);
  assert.equal(report.summary.autoWritten, 2);
  const shared = execFileSync(process.execPath, ['bin/cairn-pilot.js', '--claude-json', config, '--share'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(JSON.parse(shared).calls, 2);
  for (const value of [home, 'private.example', 'private-query-value', 'package.json', 'pilot-left', 'mcp__data360__']) assert.ok(!shared.includes(value), value);
  fs.unlinkSync(path.join(corpus, 'wrapped', 'left.json'));
  assert.equal(gatewaySetup({ root: ROOT, home: corpus, config })[0].state, 'broken');
});
