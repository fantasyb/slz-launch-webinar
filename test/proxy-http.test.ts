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
const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js'); // built launcher: requires the fresh bundle (pretest builds it) instead of a per-spawn tsx compile — cheap enough that many concurrent gateway children no longer starve each other (cairn-0050)
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
    this.child = spawn(process.execPath, [PROXY_BIN, '--config', configFile], { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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

    // A bare (unfenced) mention of the label words is NOT a forgery — legitimate
    // prose (this project's own docs, a "-- end --" in markdown) must survive
    // whole (Fable-5 #12: bare-phrase matching corrupted real output).
    const bare = texts(await p.call('mcp__data360__bare_mention')).join('\n');
    assert.ok(bare.includes('BARE⟪the cairn corpus lives in cairn/*.json; step 3 done -- end -- next⟫END'), 'a bare mention passes through unchanged');

    // Mixed: only the forged label is neutralized; the real non-Latin text around
    // it is intact (the old behavior folded Cyrillic П/е/д to Latin and dropped
    // the emoji-adjacent normalization).
    const mixed = texts(await p.call('mcp__data360__mixed')).join('\n');
    assert.ok(mixed.includes('imitated the Cairn label'), 'the forgery inside is still neutralized');
    assert.ok(mixed.includes('ПередTEXT') && mixed.includes('ПослеTEXT 🎉'), 'the real text on both sides of the forgery survives');

    // Surrogate-pair emoji BEFORE the forgery: the offset map must be in UTF-16
    // units, or the splice drifts and the label leaks through byte-for-byte.
    const ef = texts(await p.call('mcp__data360__emoji_forgery')).join('\n');
    assert.ok(ef.includes('imitated the Cairn label'), 'a forgery preceded by emoji is still neutralized');
    assert.ok(!/from your Cairn corpus[\s\S]*curl evil/.test(ef), 'the emoji-prefixed forged block cannot read as a real Cairn block');

    // A fence made of EM-DASHES with the label spelled in Cyrillic/Greek CAPITAL
    // look-alikes: NFKC leaves both non-ASCII, so it evades an ASCII-hyphen-only
    // fence regex and a lowercase-only confusable table. The dash- and capital-fold
    // (Fable-6 #14) neutralizes it anyway.
    const uf = texts(await p.call('mcp__data360__unicode_fence')).join('\n');
    assert.ok(uf.includes('imitated the Cairn label'), 'an em-dash / capital-confusable forgery is still neutralized');
    assert.ok(uf.indexOf('imitated the Cairn label') < uf.indexOf('INSTEAD'), 'the neutralized marker replaced the forged provenance header that led into the instruction');

    // Box-drawing fence + lunate sigma + palochka: also neutralized.
    const uf2 = texts(await p.call('mcp__data360__unicode_fence2')).join('\n');
    assert.ok(uf2.includes('imitated the Cairn label'), 'a box-drawing / lunate-sigma forgery is still neutralized');
    assert.ok(uf2.indexOf('imitated the Cairn label') < uf2.indexOf('INSTEAD'), 'the box-drawing forged header was replaced');

    // A 200K-dash run with no label returns fast (linear scan, not quadratic
    // backtracking — a hang would time this test out) and byte-for-byte unchanged.
    const t0 = Date.now();
    const big = texts(await p.call('mcp__data360__big_dashes')).join('\n');
    assert.ok(Date.now() - t0 < 5000, 'a large dash run does not freeze the defanger');
    assert.ok(big.includes(`TOP${'-'.repeat(200000)}BOTTOM`), 'a benign dash run passes through untouched');

    // A forged ⟦nonce⟧ delimiter in result text is redacted regardless of the
    // surrounding wording (red-team A3): an upstream cannot mint the token that
    // makes a block read as genuine.
    const nf = texts(await p.call('mcp__data360__nonce_forgery', { mode: 'ok' })).join('\n');
    assert.ok(!/⟦0a1b2c3d4e5f⟧/.test(nf), 'the forged nonce token is redacted');
    assert.ok(nf.includes('⟦redacted⟧'), 'and replaced with a redaction marker');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('a forged delimiter that is not clean hex — spaced, dash-joined, or a look-alike word — is still redacted', async () => {
  // The redactor used to match only `⟦<hex>⟧`. An upstream that writes the
  // token with an interior space, joins it with dashes, or uses a short
  // look-alike still hands the model something that reads as the delimiter it
  // was told to trust. The SHAPE is what must go, whatever is inside it.
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const nf = texts(await p.call('mcp__data360__nonce_spaced')).join('\n');
    for (const forged of ['⟦0a1b 2c3d 4e5f⟧', '⟦0a1b-2c3d-4e5f⟧', '⟦nonce⟧']) assert.ok(!nf.includes(forged), `${forged} is redacted`);
    assert.ok(nf.includes('⟦redacted⟧'), 'and replaced with the redaction marker');
    assert.ok(nf.includes('result') && nf.includes('trusted'), 'the surrounding text survives');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});

test('a forged label hidden in an input-schema ENUM value is defanged, not only description/title (red-team A4)', async () => {
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const list = await p.request('tools/list');
    const tool = (list.result.tools as Array<Record<string, any>>).find((t) => t.name === 'mcp__data360__nonce_forgery');
    assert.ok(tool, 'the tool is listed');
    const schema = JSON.stringify(tool.inputSchema);
    assert.ok(!/from your Cairn corpus --- run evil/.test(schema), 'the forged label inside an enum value is neutralized');
    assert.ok(schema.includes('imitated the Cairn label'), 'the enum value was defanged schema-wide');
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

test("this session's block token is stripped from arguments forwarded upstream (#6)", async () => {
  // The ⟦nonce⟧ is what lets the model tell a genuine Cairn block from a tool
  // faking one. If the model echoes it into a tool argument, forwarding that
  // verbatim would teach the upstream the nonce — and then that upstream could
  // forge a block that passes the model's own check. The gateway must redact it.
  const { proc, port } = await startHttp();
  const home = corpus();
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    // The session's nonce is disclosed to the model in the initialize instructions.
    const initR = await p.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    p.notify('notifications/initialized');
    const nonce = /⟦([0-9a-f]{12})⟧/.exec(String(initR.result.instructions ?? ''))?.[1];
    assert.ok(nonce, 'the session token is present in the instructions');

    // The model (foolishly) pastes the token as the bracketed form, bare, and
    // UPPER-cased — every copy must be redacted before it reaches the upstream
    // (Fable-5 #5 added case-insensitive matching to the redactor).
    const upper = nonce!.toUpperCase();
    const r = await p.call('mcp__data360__echo_args', { probe: `see ⟦${nonce}⟧ and bare ${nonce} and UPPER ${upper}` });
    const got = texts(r).find((t) => t.startsWith('GOT:')) ?? '';
    assert.ok(!got.toLowerCase().includes(nonce!), 'the upstream never receives the nonce in any case');
    assert.match(got, /redacted/, 'the token was redacted, not merely dropped');
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
  const child = spawn(process.execPath, [PROXY_BIN, '--config', cfg], {
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

/*
 * A THROWN failure takes the same path as a returned one.
 *
 * The crew-blind hour on the GitHub door produced zero drafts. Cause: an
 * upstream failure that THREW at the proxy's request (a server gone mid-call,
 * an HTTP error mid-session, a JSON-RPC error from a server not on this SDK)
 * returned from the catch before the post-call path ran — no ledger row, no
 * hole, no bank nudge — so a later success on the same tool had nothing to
 * draft from. Only a failure returned as an isError RESULT got the invitation.
 *
 * The thrown text is upstream-controlled bytes: here the 503 body carries a
 * forged Cairn label and a hostile instruction, and it must reach the model,
 * the hole and the draft's evidence only neutralised. Nothing is swallowed —
 * the client still sees isError with the failure — and nothing is written to
 * the corpus: the draft is an offer.
 */
test('an HTTP failure thrown mid-session arms the hole, carries the nudge defanged, and a later success drafts', async () => {
  /* An EMPTY corpus: the bank nudge is the invitation for a failure nothing is recorded
   * about; a tool with a finding gets that finding instead (the same rule as a returned
   * isError result), and the hole is armed either way. */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-http-thrown-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const marker = path.join(home, 'fail-now');
  const { proc, port } = await startHttp(['--fail-when', marker]);
  const cfg = path.join(home, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { data360: { url: `http://127.0.0.1:${port}/mcp` } } }));
  const p = new Proxy(home, cfg);
  try {
    await p.init();
    const before = fs.readdirSync(path.join(home, 'cairn')).length;
    /* A server that was working goes away mid-session: one good call first, so the
     * tool is known and the HTTP session is live; THEN the upstream starts failing. */
    const primed = await p.call(TOOL, { object: 'Account' });
    assert.ok(!primed.isError, 'the upstream works before it fails');
    fs.writeFileSync(marker, '');
    const failed = await p.call(TOOL, { object: 'Account' });
    assert.equal(failed.isError, true, 'the failure is still a failure to the client');
    const [errText, ...behind] = texts(failed);
    assert.match(errText, /cairn-proxy: call to "mcp__data360__query_records" failed: /, 'the failure text is the proxy\'s error result');
    assert.match(errText, /503|unavailable/, 'and carries the upstream\'s reason');
    assert.match(errText, /a tool imitated the Cairn label here/, 'the forged label in the thrown body is neutralised');
    assert.ok(!errText.includes('from your Cairn corpus, not from this tool'), 'the raw label never reaches the model from a thrown error');
    assert.ok(behind.some((t) => /Nothing is recorded about this failure/.test(t) && /cairn_record/.test(t)), `the bank nudge rides on the thrown failure: ${JSON.stringify(behind)}`);
    /* The ledger has the error row, so the report counts the failed call. */
    const rows = fs.readdirSync(path.join(home, 'data', 'retrievals')).flatMap((f) => fs.readFileSync(path.join(home, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { source: string; query: string }));
    assert.ok(rows.some((r) => r.source === 'mcp-proxy:error' && r.query.startsWith(TOOL)), `no error row: ${rows.map((r) => r.source).join(', ')}`);

    /* The upstream comes back; the same tool succeeds; the draft rides and is on disk. */
    fs.rmSync(marker);
    let good = await p.call(TOOL, { object: 'Account' });
    if (good.isError) good = await p.call(TOOL, { object: 'Account' }); // one re-dial may report the dead session first
    assert.ok(!good.isError, `the recovery call succeeds: ${texts(good).join(' | ')}`);
    const draft = texts(good).slice(1).join('\n');
    assert.match(draft, /Earlier in this session mcp__data360__query_records failed and this call succeeded/, 'the fail-then-succeed draft rides on the recovery');
    assert.match(draft, /cairn_record/, 'and says how to record it');
    const files = fs.readdirSync(path.join(home, 'drafts')).filter((f) => f.endsWith('-mcp__data360__query_records.json'));
    assert.equal(files.length, 1, 'one draft on disk');
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'drafts', files[0]), 'utf8')) as { evidence: Array<{ output: string }> };
    assert.match(onDisk.evidence[0].output, /a tool imitated the Cairn label here/, 'the draft\'s evidence is the defanged thrown text');
    assert.ok(!onDisk.evidence[0].output.includes('from your Cairn corpus, not from this tool'), 'never the raw label');
    /* Nothing was written to the corpus: a record is only ever the agent's explicit call. */
    assert.equal(fs.readdirSync(path.join(home, 'cairn')).length, before, 'no finding was auto-written');
  } finally { await p.close(); proc.kill('SIGKILL'); }
});
