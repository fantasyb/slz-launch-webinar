import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { anonymousCoverage, connect, coverage, discover, publicDiscovery, readManifest, undo, wrapper, type ClientKind } from '../src/lib/cairn/setup';
import { parseConfig, editEntry, atPath } from '../src/lib/cairn/setup-config';
import { readLedger } from '../src/lib/cairn/ledger';
import { setCairnHome } from '../src/lib/cairn/home';

const ROOT = process.cwd();
const fixture = (t: { after: (f: () => void) => void }) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-guided-'));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const write = (relative: string, content: unknown) => { const file = path.join(h, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); return file; };
  return { h, write, home: path.join(h, 'corpus'), stateDir: path.join(h, 'setup') };
};
const fixtureValue = ['fixture', 'value'].join('-');
const tokenInterpolation = '${env:TOKEN}';
const headerInterpolation = 'Bearer ' + tokenInterpolation;
const forbiddenValue = ['never', 'forward'].join('-');
const stdio = { command: process.execPath, args: [path.join(ROOT, 'fixtures/mcp/setup.mjs')], env: { SETUP_TOKEN: fixtureValue } };

test('discovers six clients and user/local/project scopes without starting servers or exposing config values', (t) => {
  const f = fixture(t), project = path.join(f.h, 'project');
  f.write('.claude.json', { mcpServers: { same: stdio }, projects: { [project]: { mcpServers: { local: stdio } } } });
  f.write('.cursor/mcp.json', { mcpServers: { same: stdio, login: { url: 'https://example.test/mcp' }, disabled: { ...stdio, disabled: true } } });
  f.write('.codeium/windsurf/mcp_config.json', { mcpServers: { same: stdio } });
  f.write('.config/Claude/claude_desktop_config.json', { mcpServers: { same: stdio } });
  f.write('.config/Code/User/mcp.json', '{ // keep comment\n "servers": {"same": {"command":"node","args":[],},},"inputs":[] }');
  f.write('.codex/config.toml', 'model="example"\n[mcp_servers.same]\ncommand="node"\nargs=[]\n');
  f.write('project/.mcp.json', { mcpServers: { same: stdio } });
  f.write('project/.cursor/mcp.json', { mcpServers: { same: stdio } });
  const d = discover({ userHome: f.h, platform: 'linux' });
  assert.equal(d.connections.length, 11);
  assert.equal(new Set(d.connections.map((c) => c.client)).size, 6);
  assert.equal(new Set(d.connections.map((c) => c.id)).size, 11);
  assert.equal(d.connections.find((c) => c.name === 'login')!.state, 'manual');
  assert.equal(d.connections.find((c) => c.name === 'disabled')!.state, 'disabled');
  assert.ok(!JSON.stringify(publicDiscovery(d)).includes('fixture-value'));
  assert.ok(!fs.existsSync(f.stateDir));
});

test('JSONC preserves comments and unrelated large integers; TOML preserves unrelated tables and rejects ambiguous layouts', () => {
  const raw = '{ // private preference\n"large":9007199254740993,"servers":{"one":{"command":"old"}},"inputs":[{"id":"key"}],}';
  const edited = editEntry(raw, 'jsonc', ['servers', 'one'], { command: 'new' });
  assert.match(edited, /9007199254740993/); assert.match(edited, /private preference/);
  assert.deepEqual(parseConfig(edited, 'jsonc').inputs, [{ id: 'key' }]);
  assert.throws(() => parseConfig('{"servers":{},"servers":{}}', 'jsonc'));
  const toml = '# preference\nmodel="example"\n[mcp_servers."one.with.dot"]\ncommand="old"\n[mcp_servers."one.with.dot".env]\nTOKEN="fixture"\n[projects."/work"]\ntrust_level="trusted"\n';
  const next = editEntry(toml, 'toml', ['mcp_servers', 'one.with.dot'], { command: 'new', args: ['a b'], env: { TOKEN: fixtureValue } });
  assert.match(next, /# preference\nmodel="example"/); assert.match(next, /\[projects\."\/work"\]\ntrust_level="trusted"/);
  assert.deepEqual(atPath(parseConfig(next, 'toml'), ['mcp_servers', 'one.with.dot']), { command: 'new', args: ['a b'], env: { TOKEN: fixtureValue } });
  assert.throws(() => editEntry('mcp_servers={one={command="old"}}', 'toml', ['mcp_servers', 'one'], { command: 'new' }));
});

test('safe setup preflights all selections, journals private originals, detects edits, and restores only owned entries', (t) => {
  const f = fixture(t);
  const file = f.write('.cursor/mcp.json', { mcpServers: { first: stdio, second: stdio }, preference: 'keep' });
  let d = discover({ userHome: f.h, platform: 'linux' });
  fs.appendFileSync(file, '\n');
  assert.throws(() => connect(d.connections, { ...f, root: ROOT, projects: [], autowrite: false }), /changed/);
  assert.ok(!fs.existsSync(path.join(f.stateDir, 'manifest.json')));
  d = discover({ userHome: f.h, platform: 'linux' });
  assert.equal(connect(d.connections, { ...f, root: ROOT, projects: [], autowrite: false }), 2);
  const m = readManifest(f.stateDir);
  assert.equal(fs.statSync(path.join(f.stateDir, 'manifest.json')).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(f.stateDir, 'backups')).mode & 0o077, 0);
  assert.equal(discover({ userHome: f.h, platform: 'linux', manifest: m }).connections.filter((c) => c.state === 'available').length, 0);
  const cfg = parseConfig(fs.readFileSync(file, 'utf8'), 'jsonc');
  (cfg.mcpServers as Record<string, unknown>).second = { command: 'user-changed' };
  cfg.preference = 'later preference';
  fs.writeFileSync(file, JSON.stringify(cfg));
  const result = undo(f.stateDir);
  assert.equal(result.restored, 1); assert.equal(result.conflicts.length, 1);
  const restored = parseConfig(fs.readFileSync(file, 'utf8'), 'jsonc');
  assert.deepEqual(atPath(restored, ['mcpServers', 'first']), stdio);
  assert.deepEqual(atPath(restored, ['mcpServers', 'second']), { command: 'user-changed' });
  assert.equal(restored.preference, 'later preference');
});

test('guided entries preserve client interpolation, auth headers, filters, cwd and explicit environment forwarding', (t) => {
  const f = fixture(t);
  f.write('.cursor/mcp.json', { mcpServers: { dynamic: { command: '${env:NODE}', args: ['${workspaceFolder}/server.js', '${env:ARG}', '--http', '--no-cairn-tools'], env: { SETUP_TOKEN: tokenInterpolation }, cwd: '${workspaceFolder}', autoApprove: ['inspect_setup'] }, remote: { url: 'https://example.test/mcp', headers: { Authorization: headerInterpolation } }, custom: { ...stdio, envFile: '.env' } } });
  const d = discover({ userHome: f.h, platform: 'linux' });
  const c = d.connections.find((c) => c.name === 'dynamic')!;
  const e = wrapper(c, ROOT, f.home, 'revision', true);
  assert.equal(e.cwd, '${workspaceFolder}'); assert.deepEqual(e.autoApprove, ['inspect_setup']);
  assert.ok((e.args as string[]).includes('${env:NODE}')); assert.ok((e.args as string[]).includes('${env:ARG}'));
  assert.equal((e.env as Record<string, string>).SETUP_TOKEN, '${env:TOKEN}');
  const remote = wrapper(d.connections.find((c) => c.name === 'remote')!, ROOT, f.home, 'revision', false);
  assert.equal((remote.env as Record<string, string>).CAIRN_UPSTREAM_HEADER_0, 'Bearer ${env:TOKEN}');
  assert.equal(remote.type, 'stdio'); assert.ok(!Object.hasOwn(remote, 'url'));
  assert.equal(d.connections.find((c) => c.name === 'custom')!.state, 'manual');
});

test('invalid, linked and remote-executor configurations are visible and never auto-edited', (t) => {
  const f = fixture(t);
  const file = f.write('linked.json', { mcpServers: { a: stdio } });
  fs.mkdirSync(path.join(f.h, '.cursor')); fs.symlinkSync(file, path.join(f.h, '.cursor/mcp.json'));
  f.write('.claude.json', '{this is invalid and contains private text');
  f.write('.codex/config.toml', '[mcp_servers.remote]\ncommand="node"\nexperimental_environment="remote"\n');
  const d = discover({ userHome: f.h, platform: 'linux' });
  assert.ok(d.files.some((f) => f.state.startsWith('unreadable')));
  assert.ok(d.connections.every((c) => c.state === 'manual'));
  assert.ok(!JSON.stringify(publicDiscovery(d)).includes('private text'));
});

test('each client adapter survives real MCP calls, keeps duplicate server identities separate, verifies only current traffic, and undoes cleanly', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const clients: Client[] = [];
  t.after(async () => { await Promise.allSettled(clients.map((c) => c.close())); });
  const extra: Array<{ client: ClientKind; file: string }> = [];
  for (const kind of ['claude', 'desktop', 'cursor', 'windsurf', 'vscode', 'codex'] as ClientKind[]) {
    const original = { ...stdio, args: [...stdio.args, 'a b', '$(never executed)', '--http', '--no-cairn-tools'], cwd: f.h, ...(kind === 'codex' ? { enabled_tools: ['inspect_setup'], env_vars: ['SETUP_ALLOWED'] } : {}) };
    const file = kind === 'codex' ? f.write(`${kind}.toml`, `[mcp_servers.same]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(original.args)}\ncwd=${JSON.stringify(f.h)}\nenabled_tools=["inspect_setup"]\nenv_vars=["SETUP_ALLOWED"]\n[mcp_servers.same.env]\nSETUP_TOKEN=${JSON.stringify(fixtureValue)}\n`) : f.write(`${kind}.json`, { [kind === 'vscode' ? 'servers' : 'mcpServers']: { same: original } });
    extra.push({ client: kind, file });
  }
  const d = discover({ userHome: f.h, platform: 'linux', extra });
  assert.equal(d.connections.length, 6); assert.ok(d.connections.every((c) => c.state === 'available'));
  connect(d.connections, { ...f, root: ROOT, projects: [], autowrite: false });
  const m = readManifest(f.stateDir);
  for (const c of m.connections) {
    const e = atPath(parseConfig(fs.readFileSync(c.file, 'utf8'), c.format), c.keys) as { command: string; args: string[]; cwd: string; env: Record<string, string> };
    const client = new Client({ name: 'same-client-name', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: e.command, args: e.args, cwd: e.cwd, env: { ...e.env, PATH: process.env.PATH!, SETUP_ALLOWED: 'allowed-value', AMBIENT_SECRET: forbiddenValue, CAIRN_KEY: forbiddenValue }, stderr: 'pipe' }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'cairn_find'), 'upstream --no-cairn-tools is not a gateway flag');
    const result = await client.callTool({ name: 'inspect_setup', arguments: {} });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.deepEqual(payload.args, ['a b', '$(never executed)', '--http', '--no-cairn-tools']);
    assert.equal(payload.cwd, f.h); assert.equal(payload.explicit, 'fixture-value');
    assert.equal(payload.ambient, false); assert.equal(payload.control, false);
    if (c.client === 'codex') assert.equal(payload.allowed, 'allowed-value');
  }
  setCairnHome(f.home);
  const rows = readLedger();
  let report = coverage(discover({ userHome: f.h, platform: 'linux', manifest: m }), m, rows);
  assert.ok(report.connections.every((c) => c.verified && c.responses === 1 && c.toolsUsed.length === 1));
  assert.equal(report.allTrafficCovered, false);
  const oldRevision = structuredClone(rows);
  for (const r of oldRevision) if (r.call) r.call.connectionRevision = 'old';
  assert.ok(coverage(discover({ userHome: f.h, platform: 'linux', manifest: m }), m, oldRevision).connections.every((c) => !c.verified));
  const shared = JSON.stringify(anonymousCoverage(report));
  for (const secret of [f.h, 'fixture-value', 'same-client-name', 'inspect_setup', 'same', 'never-forward']) assert.ok(!shared.includes(secret), secret);
  fs.writeFileSync(m.connections[0].file, editEntry(fs.readFileSync(m.connections[0].file, 'utf8'), m.connections[0].format, m.connections[0].keys, { command: 'user-new-server' }));
  report = coverage(discover({ userHome: f.h, platform: 'linux', manifest: m }), m, rows);
  assert.equal(report.connections.find((c) => c.id === m.connections[0].id)!.verified, false);
  assert.equal(undo(f.stateDir).restored, 5);
});

test('guided capture flushes while idle without a client Stop hook', { timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  f.write('.cursor/mcp.json', { mcpServers: { capture: { command: process.execPath, args: [path.join(ROOT, 'fixtures/mcp/upstream.mjs'), '--lie-shapes'] } } });
  connect(discover({ userHome: f.h, platform: 'linux' }).connections, { ...f, root: ROOT, projects: [], autowrite: true });
  const e = readManifest(f.stateDir).connections[0].installed as { command: string; args: string[]; env: Record<string, string> };
  const client = new Client({ name: 'idle-fixture', version: '1' });
  t.after(async () => { await client.close(); });
  await client.connect(new StdioClientTransport({ command: e.command, args: e.args, env: { ...e.env, PATH: process.env.PATH!, CAIRN_CAPTURE_IDLE_MS: '1000' }, stderr: 'pipe' }));
  await client.callTool({ name: 'mcp__data360__search_code', arguments: { q: 'fixture' } });
  const count = () => fs.readdirSync(path.join(f.home, 'cairn')).filter((s) => s.endsWith('.json')).length;
  assert.equal(count(), 0);
  const end = Date.now() + 8000;
  while (!count() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.equal(count(), 1);
});

test('CLI discovery is read-only, malformed flags fail, and unsupported-only setups never report coverage', (t) => {
  const f = fixture(t);
  f.write('.cursor/mcp.json', { mcpServers: { login: { url: 'https://example.test/mcp' } } });
  const env = { ...process.env, HOME: f.h };
  const run = (args: string[]) => execFileSync(process.execPath, ['bin/cairn-setup.js', ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const report = JSON.parse(run(['--discover', '--json']));
  assert.equal(report.connections[0].state, 'manual'); assert.ok(!fs.existsSync(path.join(f.h, '.cairn')));
  assert.throws(() => run(['--yes']), /--all-supported/);
  assert.throws(() => run(['--check']), (e: unknown) => (e as { status: number }).status === 2);
  assert.equal(JSON.parse(run(['--share'])).allTrafficCovered, false);
});

test('CLI connects selected project tools, remembers their locations, and can undo without repeating paths', (t) => {
  const f = fixture(t);
  const file = f.write('work/.cursor/mcp.json', { mcpServers: { task: stdio } });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: f.h };
  delete env.CAIRN_HOME; delete env.CAIRN_EVAL;
  const run = (args: string[]) => execFileSync(process.execPath, ['bin/cairn-setup.js', ...args], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run(['--project', path.join(f.h, 'work'), '--yes', '--all-supported', '--autowrite']), /Connected 1/);
  const report = JSON.parse(run(['--json']));
  assert.equal(report.connections[0].state, 'configured'); assert.equal(report.connections[0].verified, false);
  assert.match(run(['--yes', '--all-supported']), /No new supported/);
  assert.match(run(['--undo']), /Restored 1/);
  assert.deepEqual(atPath(parseConfig(fs.readFileSync(file, 'utf8'), 'jsonc'), ['mcpServers', 'task']), stdio);
});

test('partial installation remains recoverable when another client edits its file during commit', (t) => {
  const f = fixture(t);
  const a = f.write('.cursor/mcp.json', { mcpServers: { first: stdio } });
  const b = f.write('.codeium/windsurf/mcp_config.json', { mcpServers: { second: stdio } });
  const connections = discover({ userHome: f.h, platform: 'linux' }).connections;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (String(to) === a) fs.writeFileSync(b, '{"mcpServers":{"second":{"command":"new-user-choice"}}}');
  });
  assert.throws(() => connect(connections, { ...f, root: ROOT, projects: [], autowrite: false }), /changed during setup/);
  t.mock.restoreAll();
  assert.equal(readManifest(f.stateDir).connections.length, 2, 'recovery journal precedes client edits');
  const result = undo(f.stateDir);
  assert.equal(result.restored, 1); assert.equal(result.conflicts.length, 1);
  assert.deepEqual(atPath(parseConfig(fs.readFileSync(a, 'utf8'), 'jsonc'), ['mcpServers', 'first']), stdio);
  assert.equal(atPath(parseConfig(fs.readFileSync(b, 'utf8'), 'jsonc'), ['mcpServers', 'second', 'command']), 'new-user-choice');
});
