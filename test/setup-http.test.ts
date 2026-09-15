/** Actual HTTP authentication for guided adapters; requires listening sockets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect, discover, readManifest, type ClientKind } from '../src/lib/cairn/setup';

const ROOT = process.cwd();
test('guided JSON and Codex HTTP adapters forward configured headers through real upstream authentication', { timeout: 30_000 }, async (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-setup-http-'));
  const token = ['fixture', 'token'].join('-');
  const upstream = spawn(process.execPath, ['fixtures/mcp/http-upstream.mjs', '--port', '0', '--token', token], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  const clients: Client[] = [];
  t.after(async () => { await Promise.allSettled(clients.map((c) => c.close())); upstream.kill('SIGKILL'); fs.rmSync(h, { recursive: true, force: true }); });
  const port = await new Promise<number>((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => reject(new Error('HTTP fixture did not start')), 8000);
    upstream.on('error', (e) => { clearTimeout(timer); reject(e); });
    upstream.on('exit', () => { clearTimeout(timer); reject(new Error('HTTP fixture exited before startup')); });
    upstream.stderr.on('data', (d) => { pending += String(d); const m = /LISTENING (\d+)/.exec(pending); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const extra: Array<{ client: ClientKind; file: string }> = [];
  for (const kind of ['cursor', 'vscode', 'codex'] as ClientKind[]) {
    const file = path.join(h, `${kind}.${kind === 'codex' ? 'toml' : 'json'}`);
    fs.writeFileSync(file, kind === 'codex' ? `[mcp_servers.remote]\nurl=${JSON.stringify(url)}\n[mcp_servers.remote.http_headers]\nAuthorization=${JSON.stringify(`Bearer ${token}`)}\n` : JSON.stringify({ [kind === 'vscode' ? 'servers' : 'mcpServers']: { remote: { url, headers: { Authorization: `Bearer ${token}` } } } }));
    extra.push({ client: kind, file });
  }
  const stateDir = path.join(h, 'setup');
  const d = discover({ userHome: h, platform: 'linux', extra });
  connect(d.connections, { root: ROOT, home: path.join(h, 'corpus'), stateDir, projects: [], autowrite: false });
  for (const c of readManifest(stateDir).connections) {
    const e = c.installed as { command: string; args: string[]; env: Record<string, string> };
    const client = new Client({ name: 'http-test', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: e.command, args: e.args, env: { ...e.env, PATH: process.env.PATH! }, stderr: 'pipe' }));
    const result = await client.callTool({ name: 'mcp__data360__query_records', arguments: { object: 'Account' } });
    assert.equal(result.isError, undefined);
    assert.match((result.content as Array<{ text: string }>)[0].text, /records/);
  }
});
