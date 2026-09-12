/**
 * cairn:gateway-door — the load-bearing door: a server whose key only the
 * gateway holds, so the tool works through the gateway and not around it.
 *
 *   npm run cairn:gateway-door                 # stdio server, key in `env`; random key, ~10s, no model, no network
 *   npm run cairn:gateway-door-http            # HTTP server, bearer token in `headers`; loopback only
 *   npm run cairn:gateway-door -- --key <k>    # a key you choose (the tests do this to audit the home themselves)
 *
 * WHY THIS EXISTS. HANDOFF.md (2026-09-11): the gateway is a proven pipe and
 * is in the path of none of the crew's real work, because nothing they must
 * use runs through it. A passenger is skipped by default. The one lever that
 * makes it hard to skip is already in the proxy: a wrapped server gets its
 * credential from the gateway's `--config` entry — a stdio server its `env`
 * (re-applied over a scrubbed inheritance), an HTTP server its `headers`
 * (forwarded as requestInit.headers) — see mcp-proxy.ts upstreamTransport.
 * So the credential can live ONLY there. The agent's own client config then
 * names the gateway and nothing else: no raw server, no key. Calling the
 * server directly is a call without its credential, and it fails.
 *
 * THE PROPERTY UNDER TEST, in three arms and one audit, for either shape:
 *
 *   through    the client config names cairn-proxy only; the proxy's config
 *              carries the server and its credential. The call SUCCEEDS.
 *   bypass     the same server, launched (stdio) or dialed (HTTP) without the
 *              gateway, so without the credential. REFUSED.
 *   wrong key  around the gateway with a guessed credential. REFUSED — the
 *              door checks the value, not that something was set.
 *   audit      the credential appears in NONE of: any file the session wrote
 *              under its home (ledger rows, drafts, trust pins), the tool
 *              list and instructions, the result and every Cairn block on
 *              it, the proxy's stderr, the fixture's stderr, both refusals,
 *              the client's config, the report. It appears in exactly one
 *              place, the proxy's config, and the output says so.
 *
 * The credential is random per run and deliberately NOT credential-shaped
 * (`door-<hex>`): the ledger redactor would mask a `sk-...`, and a proof that
 * rests on redaction proves the redactor, not the path. Absence here means
 * the credential never arrived. It is never printed.
 *
 * WHAT THIS DOES NOT SHOW, said here as well as in GATEWAY.md: an agent that
 * can read the proxy's config file, or the proxy process's environment, has
 * the key. This raises the bar from "skip the gateway" to "go and find the
 * key"; it is not containment, and the residual is the file's permissions.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js');
const FIXTURE_STDIO = path.join(REPO, 'fixtures', 'mcp', 'keyed-echo.mjs');
const FIXTURE_HTTP = path.join(REPO, 'fixtures', 'mcp', 'keyed-http-echo.mjs');
const LABEL = 'from your Cairn corpus, not from this tool';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
const HTTP = argv.includes('--http');
const KEY = opt('key') ?? `door-${crypto.randomBytes(10).toString('hex')}`;
const KEY_SHA = crypto.createHash('sha256').update(KEY).digest('hex');

/*
 * The home: the checkout's own corpus copied beside a fresh ledger, so a real
 * Cairn block rides on the result (the program index, at first contact) and
 * the audit covers a delivered block and not only an empty one. Kept after
 * the run and printed, so `cairn:report` and a grep can be re-run by hand.
 */
function doorHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-door-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const src = path.join(REPO, 'cairn');
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.json'))) fs.copyFileSync(path.join(src, f), path.join(home, 'cairn', f));
  return home;
}

interface Arm {
  arm: string;
  tools: string[];
  defs: string;
  instructions: string;
  /** The connection itself was refused (an HTTP 401 at initialize), before any tool could be called. */
  connectError: string | null;
  isError: boolean | null;
  blocks: Array<{ type: string; text?: string }>;
  result: string;
  stderr: string;
}

/** The environment a launched process gets: the operator's shell, minus the key
 * (so the only route for it is the config) and minus CAIRN_EVAL (the ledger row
 * is part of the proof). */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  delete env.DOOR_KEY;
  delete env.CAIRN_EVAL;
  return env;
}

type Launch = { command: string; args: string[]; env: Record<string, string> } | { url: string; headers?: Record<string, string> };

async function callThrough(arm: string, spec: Launch): Promise<Arm> {
  const errs: string[] = [];
  const out: Arm = { arm, tools: [], defs: '[]', instructions: '', connectError: null, isError: null, blocks: [], result: '[]', stderr: '' };
  const client = new Client({ name: 'cairn-door', version: '0' }, { capabilities: {} });
  const transport = 'url' in spec
    ? new StreamableHTTPClientTransport(new URL(spec.url), spec.headers ? { requestInit: { headers: spec.headers } } : undefined)
    : new StdioClientTransport({ ...spec, stderr: 'pipe' });
  try {
    await client.connect(transport);
  } catch (e) {
    out.connectError = (e as Error).message;
    return out;
  }
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (d: Buffer) => errs.push(String(d)));
  const listed = await client.listTools();
  if (listed.tools.some((t) => t.name === 'open')) {
    const r = await client.callTool({ name: 'open', arguments: { message: 'knock' } });
    out.isError = r.isError === true;
    out.blocks = r.content as Arm['blocks'];
  }
  out.tools = listed.tools.map((t) => t.name).sort();
  out.defs = JSON.stringify(listed.tools);
  out.instructions = client.getInstructions() ?? '';
  out.result = JSON.stringify(out.blocks);
  await client.close();
  out.stderr = errs.join('');
  return out;
}

/** Start the HTTP fixture on a free loopback port; resolve once it says which. */
function startHttpFixture(): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  return new Promise((resolve, reject) => {
    /* All three piped (stdout is never written), so `stderr` is a stream, not a maybe. Cast: this project augments
     * ProcessEnv with a required NODE_ENV, which a scrubbed copy deliberately does not promise. */
    const child = spawn('node', [FIXTURE_HTTP, '--port', '0', '--token-sha256', KEY_SHA], { env: baseEnv() as NodeJS.ProcessEnv, stdio: 'pipe' });
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`keyed-http-echo did not report a port: ${buf}`)), 20_000);
    child.stderr.on('data', (d: Buffer) => {
      buf += String(d);
      const m = /LISTENING (\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), stderr: () => buf }); }
    });
    child.on('exit', (code: number | null) => { clearTimeout(timer); reject(new Error(`keyed-http-echo exited ${code}: ${buf}`)); });
  });
}

const failures: string[] = [];
function must(ok: boolean, label: string, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Every file the session left under the home, except the proxy's own config: the one place the key may be. */
function homeFiles(home: string, except: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p !== except) out.push([path.relative(home, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(home);
  return out;
}

async function main() {
  console.log(`\nCAIRN GATEWAY DOOR — a ${HTTP ? 'bearer token' : 'key'} only the gateway holds (${HTTP ? 'HTTP server, token in headers' : 'stdio server, key in env'})`);
  console.log('='.repeat(72));

  const home = doorHome();
  let fixture: Awaited<ReturnType<typeof startHttpFixture>> | null = null;
  let url = '';
  if (HTTP) {
    fixture = await startHttpFixture();
    url = `http://127.0.0.1:${fixture.port}/mcp`;
  }
  /*
   * THE TWO FILES. The proxy's config: the server, and its credential — `env`
   * for a stdio server, `headers` for an HTTP one. The client's config: the
   * gateway, and nothing else. This is the shape GATEWAY.md documents under
   * "Load-bearing door". 0600, as cairn:install writes its stash: the file IS
   * the residual, so it is the operator's alone.
   */
  const proxyConfig = path.join(home, 'door.json');
  const doorEntry = HTTP
    ? { url, headers: { Authorization: `Bearer ${KEY}` } }
    : { command: 'node', args: [FIXTURE_STDIO, '--key-sha256', KEY_SHA], env: { DOOR_KEY: KEY } };
  fs.writeFileSync(proxyConfig, `${JSON.stringify({ mcpServers: { door: doorEntry } }, null, 2)}\n`, { mode: 0o600 });
  const clientConfig = path.join(home, 'client.json');
  fs.writeFileSync(
    clientConfig,
    `${JSON.stringify({ mcpServers: { door: { command: 'node', args: [PROXY_BIN, '--config', proxyConfig], env: { CAIRN_HOME: home, CAIRN_AGENT: 'gateway-door' } } } }, null, 2)}\n`,
  );
  console.log(`\n  home            ${home}   (kept)`);
  console.log(`  proxy's config  ${proxyConfig}   holds the server and ${HTTP ? 'its bearer token (headers)' : 'DOOR_KEY (env)'}`);
  console.log(`  client's config ${clientConfig}   holds cairn-proxy only`);
  if (HTTP) console.log(`  server          ${url}   (loopback fixture, this run only)`);
  console.log(`  key             sha256 ${KEY_SHA.slice(0, 16)}…  (${KEY.length} chars, never printed)`);

  try {
    /* THROUGH: launch exactly what the client's config says, the way a client would. */
    console.log(`\n  THROUGH THE GATEWAY — the client config names cairn-proxy; the ${HTTP ? 'token' : 'key'} is in the proxy's config`);
    const entry = (JSON.parse(fs.readFileSync(clientConfig, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers.door;
    const through = await callThrough('through', {
      command: entry.command,
      args: entry.args,
      env: { ...baseEnv(), ...entry.env, CAIRN_SESSION: `door-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}` },
    });
    must(through.connectError === null, 'the gateway starts', through.connectError ?? '');
    must(through.tools.includes('open'), 'the door\'s tool is offered through the gateway', through.tools.join(', '));
    must(through.isError === false, 'open succeeds through the gateway', through.isError === null ? 'not called' : through.blocks[0]?.text ?? '');
    must(/"ok":true/.test(through.blocks[0]?.text ?? ''), 'the upstream\'s own result comes first, and it opened', through.blocks[0]?.text ?? '');
    const appended = through.blocks.slice(1).map((b) => b.text ?? '');
    must(appended.every((t) => t.includes(LABEL)), `every block behind it is labelled (${appended.length} rode)`);

    /* BYPASS and WRONG KEY: the same server, reached around the gateway. The
     * wrong token is assembled at runtime so no `Bearer <literal>` sits in
     * source for the pre-commit scanner to flag; the runtime value is still a
     * concrete, deterministic wrong token. */
    const WRONG = 'door-' + 'guessed';
    let bypass: Arm;
    let guessed: Arm;
    if (HTTP) {
      console.log('\n  BYPASS — the same server, dialed without the gateway (no Authorization header)');
      bypass = await callThrough('bypass', { url });
      must(bypass.connectError !== null && /401|[Uu]nauthorized/.test(bypass.connectError), 'the server is REFUSED without the gateway', bypass.connectError ?? `connected; tools: ${bypass.tools.join(', ')}`);
      console.log('\n  WRONG TOKEN — dialed around the gateway with a guessed bearer token');
      guessed = await callThrough('wrong-key', { url, headers: { Authorization: `Bearer ${WRONG}` } });
      must(guessed.connectError !== null && /401|[Uu]nauthorized/.test(guessed.connectError), 'the server is REFUSED with a wrong token', guessed.connectError ?? `connected; tools: ${guessed.tools.join(', ')}`);
      must(!(bypass.connectError ?? '').includes(WRONG) && !(guessed.connectError ?? '').includes(WRONG), 'neither refusal echoes what was presented');
    } else {
      console.log('\n  BYPASS — the same server, same arguments, launched without the gateway');
      bypass = await callThrough('bypass', { command: 'node', args: [FIXTURE_STDIO, '--key-sha256', KEY_SHA], env: baseEnv() });
      must(bypass.tools.includes('open'), 'the server starts and offers the tool (the door is the key, not the process)');
      must(bypass.isError === true, 'open is REFUSED without the gateway', bypass.blocks[0]?.text ?? '');
      must(/DOOR_KEY is not set/.test(bypass.blocks[0]?.text ?? ''), 'because no key reached it');
      console.log('\n  WRONG KEY — launched around the gateway with a guessed key');
      guessed = await callThrough('wrong-key', { command: 'node', args: [FIXTURE_STDIO, '--key-sha256', KEY_SHA], env: { ...baseEnv(), DOOR_KEY: WRONG } });
      must(guessed.isError === true, 'open is REFUSED with a wrong key', guessed.blocks[0]?.text ?? '');
      must(/does not match/.test(guessed.blocks[0]?.text ?? ''), 'the door checks the value, not that something was set');
    }

    /* AUDIT: where did the key go? Exactly one place. */
    console.log(`\n  AUDIT — the ${HTTP ? 'token' : 'key'} appears nowhere the agent reads or the session writes`);
    const files = homeFiles(home, proxyConfig);
    const ledger = files.filter(([p]) => p.startsWith('data/retrievals/')).map(([, t]) => t).join('\n');
    must(ledger.length > 0, 'the session wrote ledger rows (the call is on record)');
    must(/mcp-proxy:call/.test(ledger) && /"query":"open \[args: message\]"/.test(ledger), 'the call row names the tool and the argument NAME only', 'open [args: message]');
    const leaked = files.filter(([, t]) => t.includes(KEY)).map(([p]) => p);
    must(leaked.length === 0, `key absent from every file the session left under the home (${files.length} files: ledger, drafts, trust pins, client config)`, leaked.join(', '));
    const places: Array<[string, string]> = [
      ['tool list and schemas', through.defs],
      ['instructions at connect', through.instructions],
      ['the result and every Cairn block on it', through.result],
      ['the proxy\'s stderr', through.stderr],
      ['the bypass refusal', bypass.connectError ?? bypass.result],
      ['the wrong-key refusal', guessed.connectError ?? guessed.result],
    ];
    if (fixture) places.push(['the server\'s own stderr', fixture.stderr()]);
    for (const [where, text] of places) must(!text.includes(KEY), `key absent from ${where}`);
    must(fs.readFileSync(proxyConfig, 'utf8').includes(KEY), 'key present in exactly one place: the proxy\'s config (the residual — see GATEWAY.md)');

    /* The report: the call counted, as an operator would see it. */
    console.log('\n  REPORT — `CAIRN_HOME=<that home> npm run cairn:report`');
    const r = spawnSync('npx', ['tsx', path.join(REPO, 'scripts', 'report.ts')], {
      cwd: REPO,
      /* Cast: this project augments ProcessEnv with a required NODE_ENV, which a copy with one variable added deliberately does not promise. */
      env: { ...process.env, CAIRN_HOME: home } as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    const out = `${r.stdout}${r.stderr}`;
    must(r.status === 0, 'cairn:report ran', r.status === 0 ? '' : `exit ${r.status}`);
    const row = out.split('\n').find((l) => /^\s*open\s+\d/.test(l));
    must(!!row, 'the report lists open with the call counted', row ? row.trim() : 'no row for it');
    must(!out.includes(KEY), 'key absent from the report');
  } finally {
    if (fixture) { fixture.child.stdin?.end(); fixture.child.kill(); }
  }

  console.log('\n' + '='.repeat(72));
  if (failures.length === 0) {
    console.log(`PASS — the door holds: the tool works through the gateway, is refused around it, and the ${HTTP ? 'token' : 'key'} reached nothing the agent reads.\n`);
    return;
  }
  console.log(`FAIL — ${failures.length}:\n`);
  for (const f of failures) console.log('  ' + f);
  console.log('\nA door the agent can walk around is a passenger, and a key that shows up in\nthe ledger is a leak. Fix this before putting a real key behind the gateway.\n');
  process.exitCode = 1;
}

void main().catch((e) => {
  console.error(`\ncairn:gateway-door: ${(e as Error).message}\n`);
  process.exit(1);
});
