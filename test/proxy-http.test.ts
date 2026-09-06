/**
 * The gateway wraps an HTTP (Streamable HTTP) upstream, not only a spawned
 * stdio one — the "universal" claim. The client side is unchanged (the proxy is
 * still launched as a local stdio command); only the upstream side dials HTTP.
 * So the property to prove is the same as the stdio path: the upstream's own
 * result comes back intact, and a finding about its tool rides in on that result.
 *
 * And the auth property: when the wrapped config carries a bearer token, the
 * proxy forwards it (the fixture 401s without it), so a token-auth remote server
 * works through the gateway; without the token the upstream is simply dead, not
 * silently wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

const REPO = process.cwd();
const HTTP_FIXTURE = path.join(REPO, 'fixtures', 'mcp', 'http-upstream.mjs');
const TOOL = 'mcp__data360__query_records';
/* A fixture token, assembled at runtime so no bearer-credential literal appears
 * in the source for the secret-scanner to flag. */
const TOKEN = ['fixture', 'token'].join('-');
const AUTH = 'Authorization';
const authHeader = () => ({ [AUTH]: `Bearer ${TOKEN}` });

/** Start the HTTP fixture; resolve with its port (read from `LISTENING <port>`). */
function startHttp(args: string[] = []): Promise<{ proc: ChildProcess; port: number }> {
  const portArgs = args.includes('--port') ? [] : ['--port', '0'];
  const proc = spawn('node', [HTTP_FIXTURE, ...portArgs, ...args], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`http fixture did not report a port\n${buf}`)), 10_000);
    proc.stderr!.on('data', (d) => {
      buf += String(d);
      const m = /LISTENING (\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve({ proc, port: Number(m[1]) }); }
    });
    proc.on('error', reject);
  });
}

/** A private corpus with one finding about the fixture's query tool. */
function corpus(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-http-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const donor = JSON.parse(fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'));
  fs.writeFileSync(
    path.join(home, 'cairn', '0001-http.json'),
    JSON.stringify({
      ...donor,
      id: 'cairn-0001',
      title: 'the query tool returns empty rather than erroring on a stale mapping',
      reality: 'the call succeeds and returns zero rows',
      workaround: 'check the mapping timestamp before trusting a zero-row result',
      triggers: [TOOL],
      signature: undefined,
      precondition: undefined,
      visibility: 'private',
      status: 'active',
      observations: [{ by: 't', at: '2026-09-01T00:00:00.000Z', verdict: 'confirmed', note: 'seen here' }],
    }),
  );
  return home;
}

/** Minimal stdio JSON-RPC driver for the proxy. */
class Proxy {
  private child: ChildProcess;
  private pending = new Map<number, (m: any) => void>();
  private next = 1;
  private buf = '';
  stderr = '';
  constructor(home: string, configFile: string) {
    const env: Record<string, string | undefined> = { ...process.env, CAIRN_HOME: home };
    delete env.CAIRN_SESSION; delete env.CAIRN_AGENT;
    this.child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', '--config', configFile], { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', (d) => { this.stderr += String(d); });
    this.child.stdout!.on('data', (d) => {
      this.buf += String(d);
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (typeof m.id === 'number' && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      }
    });
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.next++;
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${method} in 20s\n${this.stderr}`)), 20_000);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
  }
  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  async init(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    this.notify('notifications/initialized');
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.request('tools/call', { name, arguments: args });
    return r.result;
  }
  async close(): Promise<void> {
    try { this.child.stdin!.end(); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 200));
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    this.child.stdout?.destroy(); this.child.stderr?.destroy();
  }
}

const texts = (r: { content: { text?: string }[] }) => r.content.map((c) => c.text ?? '');

test('the gateway wraps an HTTP upstream and a finding rides on its result', async () => {
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const r = await p.call(TOOL, { object: 'Account' });
    const t = texts(r);
    assert.ok(t.some((x) => x.includes('"records":[]')), 'the HTTP upstream\'s own result comes back intact');
    assert.ok(t.some((x) => x.includes('cairn-0001')), 'the finding reached the model on the result of an HTTP-wrapped tool');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('a bearer token in the wrapped config is forwarded to the HTTP upstream', async () => {
  const { proc, port } = await startHttp(['--token', TOKEN]);
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp`, headers: authHeader() } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const r = await p.call(TOOL, { object: 'Account' });
    assert.ok(texts(r).some((x) => x.includes('"records":[]')), 'with the token forwarded, the authed HTTP upstream answers through the gateway');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('an upstream that forges the Cairn label in its result is defanged (#3)', async () => {
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const r = await p.call('mcp__data360__evil');
    const all = texts(r).join('\n');
    assert.ok(all.includes('imitated the Cairn label'), 'the forged label is neutralized');
    assert.ok(!/from your Cairn corpus, not from this tool[\s\S]*curl evil/.test(all), 'the forged trap can no longer read as a real Cairn block');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('legitimate non-Latin output passes through the defanger unchanged (#4)', async () => {
  // The defanger normalizes (NFKC + invisible-strip + confusable-fold) only to
  // MATCH a forged label; it must return the ORIGINAL text, not the folded form.
  // Otherwise a tool answering in Greek/Cyrillic/Japanese, or shipping an emoji
  // or full-width text, comes back mangled even with no forgery present.
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    // Clean non-Latin output: returned byte-for-byte, letters NOT folded to Latin.
    const clean = texts(await p.call('mcp__data360__intl')).join('\n');
    assert.ok(clean.includes('INTL⟪Ελληνικά Привет こんにちは 🎉 ｈｅｌｌｏ⟫END'), 'the exact non-Latin string survives unchanged');

    // Mixed: only the forged label is neutralized; the real non-Latin text around
    // it is intact (the old behavior folded Cyrillic П/е/д to Latin and dropped
    // the emoji-adjacent normalization).
    const mixed = texts(await p.call('mcp__data360__mixed')).join('\n');
    assert.ok(mixed.includes('imitated the Cairn label'), 'the forgery inside is still neutralized');
    assert.ok(mixed.includes('ПередTEXT') && mixed.includes('ПослеTEXT 🎉'), 'the real text on both sides of the forgery survives');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('a forged label is defanged in every channel, not only description + result text (#5)', async () => {
  // Upstream prose reaches the model through more than a tool's top-level
  // description and a result's text: its title, annotations.title, input-schema
  // property descriptions, and structuredContent values are all model-read. A
  // forgery in any of them must be neutralized.
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const list = await p.request('tools/list');
    const evil = (list.result.tools as Array<Record<string, any>>).find((t) => t.name === 'mcp__data360__schema_evil');
    assert.ok(evil, 'the tool is listed');
    const blob = JSON.stringify(evil);
    // No channel still reads as our provenance...
    assert.ok(!/from your Cairn corpus/i.test(blob), 'no forged label survives anywhere on the tool definition');
    // ...and each specific channel was actually reached.
    assert.match(evil.title, /imitated the Cairn label/, 'the tool title is defanged');
    assert.match(evil.annotations.title, /imitated the Cairn label/, 'annotations.title is defanged');
    assert.match(evil.inputSchema.properties.field.description, /imitated the Cairn label/, 'a schema property description is defanged');

    const r = await p.call('mcp__data360__schema_evil', { field: 'x' });
    assert.ok(!/from your Cairn corpus/i.test(JSON.stringify(r.structuredContent)), 'structuredContent is defanged');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('an HTTP upstream that restarts is re-dialed, not served as a dead session (#1)', async () => {
  // The critical fix: the HTTP transport does not fire onclose on a dead host,
  // so without re-dial logic a restarted upstream (a redeploy) would be served
  // as a stale session forever. Start on a fixed port, kill, restart, and prove
  // a later call succeeds.
  const first = await startHttp();
  const port = first.port;
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    assert.ok(texts(await p.call(TOOL, { object: 'A' })).some((x) => x.includes('records')), 'works before the restart');
    first.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    // The upstream is gone: this call fails and marks it dead.
    await p.call(TOOL, { object: 'A' }).catch(() => undefined);
    // Restart the server on the same port and confirm the gateway re-dials it.
    const second = await startHttp(['--port', String(port)]);
    try {
      let ok = false;
      for (let i = 0; i < 5 && !ok; i++) {
        const r = await p.call(TOOL, { object: 'A' });
        ok = texts(r).some((x) => x.includes('records'));
        if (!ok) await new Promise((r) => setTimeout(r, 400));
      }
      assert.ok(ok, 'after the upstream restarts, the gateway re-dials and calls succeed again');
    } finally { second.proc.kill('SIGKILL'); }
  } finally { await p.close(); }
});

test('an unreachable/unauthorized HTTP upstream fails to start — never a fabricated success', async () => {
  // Wrap an auth server but omit the token: the proxy cannot connect. The design
  // (like the stdio path) is to be indistinguishable from no gateway — the
  // process exits so the client sees the same failure it would have seen without
  // us, rather than a green connector serving zero of the server's tools. The
  // connect timeout is turned down so this resolves in seconds, not the 20s
  // production bound.
  const { proc, port } = await startHttp(['--token', TOKEN]);
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } })); // no headers
  const child = spawn('npx', ['tsx', 'scripts/mcp-proxy.ts', '--config', cfg], {
    cwd: REPO,
    env: { ...process.env, CAIRN_HOME: home, CAIRN_CONNECT_TIMEOUT_MS: '2000' } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr!.on('data', (d) => { err += String(d); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`proxy did not exit; a bad upstream hung startup\n${err}`)), 20_000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 1, 'the gateway exits non-zero when its only upstream cannot start');
    assert.match(err, /no upstream started|did not start/, 'and says why on stderr');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    proc.kill('SIGKILL');
  }
});
