/**
 * cairn:gateway-door — the load-bearing door: a server whose key only the
 * gateway holds, so the tool works through the gateway and not around it.
 *
 *   npm run cairn:gateway-door                 # random key, fixture server, ~10s, no model, no network
 *   npm run cairn:gateway-door -- --key <k>    # a key you choose (the test does this to audit the home itself)
 *
 * WHY THIS EXISTS. HANDOFF.md (2026-09-11): the gateway is a proven pipe and
 * is in the path of none of the crew's real work, because nothing they must
 * use runs through it. A passenger is skipped by default. The one lever that
 * makes it hard to skip is already in the proxy: a wrapped stdio server gets
 * its environment from the gateway's `--config` entry (`env`, re-applied over
 * a scrubbed inheritance — mcp-proxy.ts upstreamTransport), so the server's
 * API key can live ONLY there. The agent's own client config then names the
 * gateway and nothing else: no raw server, no key. Calling the server
 * directly is a call without its credential, and it fails.
 *
 * THE PROPERTY UNDER TEST, in three arms and one audit:
 *
 *   through    the client config names cairn-proxy only; the proxy's config
 *              carries the server and DOOR_KEY. The call SUCCEEDS.
 *   bypass     the same server, same arguments, launched without the gateway
 *              (so without DOOR_KEY). The call is REFUSED.
 *   wrong key  launched around the gateway with a guessed key. REFUSED — the
 *              door checks the value, not that something was set.
 *   audit      the key appears in NONE of: the ledger rows the session
 *              wrote, the tool list and instructions, the result and every
 *              Cairn block on it, the proxy's stderr, the bypass error text,
 *              the drafts directory, the client's config file. It appears in
 *              exactly one place, the proxy's config, and the output says so.
 *
 * The key is random per run and deliberately NOT credential-shaped
 * (`door-<hex>`): the ledger redactor would mask a `sk-...`, and a proof that
 * rests on redaction proves the redactor, not the path. Absence here means
 * the key never arrived.
 *
 * WHAT THIS DOES NOT SHOW, said here as well as in GATEWAY.md: an agent that
 * can read the proxy's config file, or the proxy process's environment, has
 * the key. This raises the bar from "skip the gateway" to "go and find the
 * key"; it is not containment, and the residual is the file's permissions.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js');
const FIXTURE = path.join(REPO, 'fixtures', 'mcp', 'keyed-echo.mjs');
const LABEL = 'from your Cairn corpus, not from this tool';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
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

async function callThrough(arm: string, spec: { command: string; args: string[]; env: Record<string, string> }): Promise<Arm> {
  const transport = new StdioClientTransport({ ...spec, stderr: 'pipe' });
  const errs: string[] = [];
  const client = new Client({ name: 'cairn-door', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', (d: Buffer) => errs.push(String(d)));
  const listed = await client.listTools();
  let isError: boolean | null = null;
  let blocks: Arm['blocks'] = [];
  if (listed.tools.some((t) => t.name === 'open')) {
    const r = await client.callTool({ name: 'open', arguments: { message: 'knock' } });
    isError = r.isError === true;
    blocks = r.content as Arm['blocks'];
  }
  const out: Arm = {
    arm,
    tools: listed.tools.map((t) => t.name).sort(),
    defs: JSON.stringify(listed.tools),
    instructions: client.getInstructions() ?? '',
    isError,
    blocks,
    result: JSON.stringify(blocks),
    stderr: errs.join(''),
  };
  await client.close();
  return out;
}

const failures: string[] = [];
function must(ok: boolean, label: string, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Every byte the session wrote under the home's ledger and drafts, for the audit. */
function readAll(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

async function main() {
  console.log('\nCAIRN GATEWAY DOOR — a key only the gateway holds');
  console.log('='.repeat(72));

  const home = doorHome();
  /*
   * THE TWO FILES. The proxy's config: the server, its arguments, and its key.
   * The client's config: the gateway, and nothing else. This is the shape
   * GATEWAY.md documents under "Load-bearing door".
   */
  const proxyConfig = path.join(home, 'door.json');
  /* 0600, as cairn:install writes its stash: the file IS the residual, so it is the operator's alone. */
  fs.writeFileSync(
    proxyConfig,
    `${JSON.stringify({ mcpServers: { door: { command: 'node', args: [FIXTURE, '--key-sha256', KEY_SHA], env: { DOOR_KEY: KEY } } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const clientConfig = path.join(home, 'client.json');
  fs.writeFileSync(
    clientConfig,
    `${JSON.stringify({ mcpServers: { door: { command: 'node', args: [PROXY_BIN, '--config', proxyConfig], env: { CAIRN_HOME: home, CAIRN_AGENT: 'gateway-door' } } } }, null, 2)}\n`,
  );
  console.log(`\n  home            ${home}   (kept)`);
  console.log(`  proxy's config  ${proxyConfig}   holds the server and DOOR_KEY`);
  console.log(`  client's config ${clientConfig}   holds cairn-proxy only`);
  console.log(`  key             sha256 ${KEY_SHA.slice(0, 16)}…  (${KEY.length} chars, never printed)`);

  /* THROUGH: launch exactly what the client's config says, the way a client would. */
  console.log('\n  THROUGH THE GATEWAY — the client config names cairn-proxy; the key is in the proxy\'s config');
  const entry = (JSON.parse(fs.readFileSync(clientConfig, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers.door;
  const through = await callThrough('through', {
    command: entry.command,
    args: entry.args,
    env: { ...baseEnv(), ...entry.env, CAIRN_SESSION: `door-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}` },
  });
  must(through.tools.includes('open'), 'the door\'s tool is offered through the gateway', through.tools.join(', '));
  must(through.isError === false, 'open succeeds through the gateway', through.isError === null ? 'not called' : through.blocks[0]?.text ?? '');
  must(/"ok":true/.test(through.blocks[0]?.text ?? ''), 'the upstream\'s own result comes first, and it opened', through.blocks[0]?.text ?? '');
  const appended = through.blocks.slice(1).map((b) => b.text ?? '');
  must(appended.every((t) => t.includes(LABEL)), `every block behind it is labelled (${appended.length} rode)`);

  /* BYPASS: the same server, launched around the gateway. No key reaches it. */
  console.log('\n  BYPASS — the same server, same arguments, launched without the gateway');
  const bypass = await callThrough('bypass', { command: 'node', args: [FIXTURE, '--key-sha256', KEY_SHA], env: baseEnv() });
  must(bypass.tools.includes('open'), 'the server starts and offers the tool (the door is the key, not the process)');
  must(bypass.isError === true, 'open is REFUSED without the gateway', bypass.blocks[0]?.text ?? '');
  must(/DOOR_KEY is not set/.test(bypass.blocks[0]?.text ?? ''), 'because no key reached it');

  console.log('\n  WRONG KEY — launched around the gateway with a guessed key');
  const guessed = await callThrough('wrong-key', { command: 'node', args: [FIXTURE, '--key-sha256', KEY_SHA], env: { ...baseEnv(), DOOR_KEY: 'door-guessed' } });
  must(guessed.isError === true, 'open is REFUSED with a wrong key', guessed.blocks[0]?.text ?? '');
  must(/does not match/.test(guessed.blocks[0]?.text ?? ''), 'the door checks the value, not that something was set');

  /* AUDIT: where did the key go? Exactly one place. */
  console.log('\n  AUDIT — the key appears nowhere the agent reads or the session writes');
  const ledger = readAll(path.join(home, 'data', 'retrievals'));
  const drafts = readAll(path.join(home, 'drafts'));
  must(ledger.length > 0, 'the session wrote ledger rows (the call is on record)');
  must(/mcp-proxy:call/.test(ledger) && /"query":"open \[args: message\]"/.test(ledger), 'the call row names the tool and the argument NAME only', 'open [args: message]');
  const places: Array<[string, string]> = [
    ['ledger rows', ledger],
    ['drafts', drafts],
    ['tool list and schemas', through.defs],
    ['instructions at connect', through.instructions],
    ['the result and every Cairn block on it', through.result],
    ['the proxy\'s stderr', through.stderr],
    ['the bypass error', bypass.result],
    ['the wrong-key error', guessed.result],
    ['the client\'s config', fs.readFileSync(clientConfig, 'utf8')],
  ];
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

  console.log('\n' + '='.repeat(72));
  if (failures.length === 0) {
    console.log('PASS — the door holds: the tool works through the gateway, is refused around it, and the key reached nothing the agent reads.\n');
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
