/** Real OAuth authorization code + PKCE, refresh and gateway traffic. Requires sockets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LocalOAuthProvider, oauthFile, readOAuth, signIn } from '../src/lib/cairn/oauth';
import { connect, discover, readManifest } from '../src/lib/cairn/setup';

type Cleanup = { after: (fn: () => void | Promise<void>) => void };
async function fixture(t: Cleanup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-oauth-http-'));
  const clients = new Map<string, { redirect_uris: string[] }>(), codes = new Map<string, URLSearchParams>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const access = new Set<string>(), refresh = new Set<string>();
  const stats = { registrations: 0, grants: 0, refreshes: 0, toolCalls: 0, public: false, deny: false };
  let base = '';
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url!, base);
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      let raw = '';
      if (req.method === 'POST') for await (const chunk of req) raw += String(chunk);
      if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['tools'] });
      if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, {
        issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      });
      if (u.pathname === '/register') {
        const body = JSON.parse(raw), id = randomUUID(); clients.set(id, body); stats.registrations++;
        return json(201, { ...body, client_id: id });
      }
      if (u.pathname === '/authorize') {
        const q = u.searchParams, client = clients.get(q.get('client_id')!);
        if (!client?.redirect_uris.includes(q.get('redirect_uri')!) || q.get('code_challenge_method') !== 'S256' || q.get('resource') !== base + '/mcp') return json(400, { error: 'invalid_request' });
        const callback = new URL(q.get('redirect_uri')!); callback.searchParams.set('state', q.get('state')!);
        if (stats.deny) callback.searchParams.set('error', 'access_denied');
        else { const code = randomUUID(); codes.set(code, q); callback.searchParams.set('code', code); }
        res.writeHead(302, { location: callback.href }); res.end(); return;
      }
      if (u.pathname === '/token') {
        const q = new URLSearchParams(raw);
        if (q.get('grant_type') === 'authorization_code') {
          const code = q.get('code')!, original = codes.get(code); codes.delete(code);
          if (!original || q.get('client_id') !== original.get('client_id') || q.get('redirect_uri') !== original.get('redirect_uri') || createHash('sha256').update(q.get('code_verifier') ?? '').digest('base64url') !== original.get('code_challenge')) return json(400, { error: 'invalid_grant' });
          stats.grants++;
        } else if (q.get('grant_type') === 'refresh_token') {
          const value = q.get('refresh_token')!;
          if (!refresh.delete(value)) return json(400, { error: 'invalid_grant' });
          stats.refreshes++;
        } else return json(400, { error: 'unsupported_grant_type' });
        const a = randomUUID(), r = randomUUID(); access.add(a); refresh.add(r);
        return json(200, { access_token: a, refresh_token: r, token_type: 'Bearer', expires_in: 3600 });
      }
      if (u.pathname !== '/mcp') return json(404, {});
      if (!stats.public && !access.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) {
        res.setHeader('WWW-Authenticate', 'Bearer ' + `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
        return json(401, { error: 'unauthorized' });
      }
      const body = raw ? JSON.parse(raw) : undefined;
      const existing = sessions.get(String(req.headers['mcp-session-id']));
      if (existing) { await existing.handleRequest(req, res, body); return; }
      if (req.method === 'POST' && isInitializeRequest(body)) {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: (id) => { sessions.set(id, transport); } });
        const mcp = new McpServer({ name: 'oauth-fixture', version: '1' });
        mcp.registerTool('fixture_read', { inputSchema: {} }, async () => { stats.toolCalls++; return { content: [{ type: 'text', text: 'connected through OAuth' }] }; });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        await mcp.connect(transport); await transport.handleRequest(req, res, body); return;
      }
      json(400, { error: 'initialize first' });
    } catch { res.writeHead(500); res.end('fixture failed'); }
  });
  t.after(async () => { await Promise.all([...sessions.values()].map((s) => s.close())); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = async (url: URL) => {
    const r = await fetch(url, { redirect: 'manual' }); assert.equal(r.status, 302);
    const callback = r.headers.get('location')!;
    assert.equal((await fetch(callback)).status, 200); return callback;
  };
  return { dir, url: base + '/mcp', stats, access, refresh, browser };
}

test('browser consent verifies before install, credentials survive restart and rotate on expiry', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t), stateDir = path.join(f.dir, 'setup');
  fs.mkdirSync(path.join(f.dir, '.cursor'));
  fs.writeFileSync(path.join(f.dir, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { remote: { url: f.url } } }));
  const found = discover({ userHome: f.dir, platform: 'linux' }), c = found.connections[0], file = oauthFile(stateDir, c.id);
  let callback = '';
  const result = await signIn({ file, serverUrl: f.url, open: async (u) => {
    const r = await fetch(u, { redirect: 'manual' }), correct = new URL(r.headers.get('location')!);
    const wrong = new URL(correct); wrong.searchParams.set('state', '💥'.repeat(43));
    assert.equal((await fetch(wrong)).status, 400);
    callback = correct.href; assert.equal((await fetch(callback)).status, 200);
    assert.equal((await fetch(callback)).status, 400); // callback is single-use
  } });
  assert.equal(result.tools, 1); assert.equal(f.stats.toolCalls, 0); assert.equal(f.stats.grants, 1);
  const first = readOAuth(file, f.url).tokens!;
  connect([c], { root: process.cwd(), home: path.join(f.dir, 'corpus'), stateDir, projects: [], autowrite: true });
  const installed = readManifest(stateDir).connections[0].installed as { command: string; args: string[]; env: Record<string, string> };
  assert.ok(!JSON.stringify(installed).includes(first.access_token));
  const p = new LocalOAuthProvider(file, f.url); p.saveTokens({ ...first, expires_in: -1 });
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: 'oauth-gateway-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: installed.command, args: installed.args, env: { ...installed.env, PATH: process.env.PATH! }, stderr: 'pipe' }));
      const response = await client.callTool({ name: 'fixture_read', arguments: {} });
      assert.equal(response.isError, undefined);
      assert.match(JSON.stringify(response.content), /connected through OAuth/);
    } finally { await client.close(); }
  }
  assert.equal(f.stats.toolCalls, 2); assert.equal(f.stats.refreshes, 1);
  assert.notEqual(readOAuth(file, f.url).tokens?.refresh_token, first.refresh_token);
  await signIn({ file, serverUrl: f.url, open: async () => { throw new Error('healthy login must not open browser'); } });
  assert.equal(f.stats.registrations, 1);
  // Revocation is visible and repaired within setup, without editing the installed config.
  f.access.clear(); f.refresh.clear();
  await signIn({ file, serverUrl: f.url, open: async (u) => { await f.browser(u); } });
  assert.equal(f.stats.grants, 2); assert.equal(readOAuth(file, f.url).needsLogin, false);
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  await signIn({ file, serverUrl: f.url, repair: true, open: async (u) => { await f.browser(u); } });
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.recovery')));
  assert.equal(readOAuth(file, f.url).needsLogin, false);
});
test('denied and abandoned logins leave original app config usable and retry succeeds', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), file = oauthFile(path.join(f.dir, 'setup'), 'b'.repeat(24));
  const config = path.join(f.dir, 'mcp.json'), original = JSON.stringify({ mcpServers: { remote: { url: f.url } } }); fs.writeFileSync(config, original);
  f.stats.deny = true;
  await assert.rejects(signIn({ file, serverUrl: f.url, open: async (u) => { await f.browser(u); } }), /did not finish/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  f.stats.deny = false;
  await assert.rejects(signIn({ file, serverUrl: f.url, timeoutMs: 300, open: async () => {} }), /did not finish/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.ok(!fs.existsSync(file + '.login.lock'));
  assert.equal((await signIn({ file, serverUrl: f.url, open: async (u) => { await f.browser(u); } })).tools, 1);
});
test('public MCP connection is checked without asking for OAuth consent', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); f.stats.public = true;
  const file = oauthFile(path.join(f.dir, 'setup'), 'c'.repeat(24));
  assert.equal((await signIn({ file, serverUrl: f.url, open: async () => { throw new Error('no login needed'); } })).tools, 1);
  assert.equal(f.stats.registrations, 0); assert.equal(readOAuth(file, f.url).tokens, undefined);
  assert.ok(readOAuth(file, f.url).checkedAt);
});


test('guided CLI completes browser sign-in and repairs a missing login without manual config edits', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), stateDir = path.join(f.dir, 'setup');
  fs.mkdirSync(path.join(f.dir, '.cursor'));
  fs.writeFileSync(path.join(f.dir, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { remote: { url: f.url } } }));
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/cairn-setup.js', '--state-dir', stateDir, '--home', path.join(f.dir, 'corpus'), '--no-browser', ...args], { env: { ...process.env, HOME: f.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', opened = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI sign-in timed out')); }, 8000);
    const collect = (data: Buffer) => {
      output += String(data);
      const match = output.match(/^http:\/\/127\.0\.0\.1:\d+\/authorize\S+/m);
      if (match && !opened) { opened = true; void f.browser(new URL(match[0])).catch(reject); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  const first = await run(['--yes', '--all-supported']);
  assert.equal(first.code, 0, first.output); assert.match(first.output, /Connected 1 tool connections/);
  const c = readManifest(stateDir).connections[0], file = oauthFile(stateDir, c.id);
  const record = readOAuth(file, f.url);
  assert.ok(!first.output.includes(record.tokens!.access_token)); assert.equal(f.stats.toolCalls, 0);
  const originalInstalled = fs.readFileSync(c.file, 'utf8');
  fs.unlinkSync(file);
  const repaired = await run(['--yes', '--all-supported']);
  assert.equal(repaired.code, 0, repaired.output); assert.match(repaired.output, /SIGN-IN NEEDS ATTENTION/);
  assert.ok(readOAuth(file, f.url).tokens); assert.equal(fs.readFileSync(c.file, 'utf8'), originalInstalled);
});
