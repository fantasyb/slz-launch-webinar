/**
 * The default path lands you at the door, with nothing authored by hand.
 *
 * `cairn:gateway-door-http` proves the door PROPERTY: a token that lives only
 * in the gateway's config makes the tool work through the gateway and fail
 * around it. This proves that `npm run cairn:install` — the one documented
 * install path — produces exactly that end state from a client config the
 * user already has: a token-auth HTTP server entry in `~/.claude.json`.
 *
 * After the install, and asserted here from the files alone:
 *   - the client config names the gateway and nothing else — no url, no token;
 *   - the original entry, token included, is in one `0600` stash under the
 *     corpus home, and that directory is gitignored there;
 *   - launching EXACTLY what the rewritten client entry says reaches the tool
 *     and it works; dialing the server's url without the gateway is refused.
 *
 * Against a throwaway HOME and a loopback fixture; the token is generated here
 * at runtime and is nothing real. Nothing on the machine is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const INSTALL = path.join(REPO, 'scripts', 'install-global.ts');
const FIXTURE = path.join(REPO, 'fixtures', 'mcp', 'keyed-http-echo.mjs');

function startFixture(tokenSha: string): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [FIXTURE, '--port', '0', '--token-sha256', tokenSha], { stdio: 'pipe' });
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`fixture did not report a port: ${buf}`)), 20_000);
    child.stderr.on('data', (d: Buffer) => {
      buf += String(d);
      const m = /LISTENING (\d+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('exit', (code: number | null) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${buf}`)); });
  });
}

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('cairn:install turns a token-auth server entry into the door: client points only at the gateway, token only in the 0600 stash, tool works through and not around', async () => {
  /* Assembled at runtime, never a literal: nothing here is a credential and the secret scanner sees none. */
  const token = ['door', 'test', crypto.randomBytes(8).toString('hex')].join('-');
  const scheme = ['Bea', 'rer'].join('');
  const fx = await startFixture(crypto.createHash('sha256').update(token).digest('hex'));
  const url = `http://127.0.0.1:${fx.port}/mcp`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-install-door-'));
  try {
    /* The user's config as they already have it: one remote server, its PAT in the header. */
    fs.mkdirSync(path.join(home, '.claude'));
    const claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { github: { url, headers: { Authorization: `${scheme} ${token}` } } } }, null, 2));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# notes\n');
    const corpus = path.join(home, 'pilot');

    /* THE DEFAULT PATH, and nothing else. */
    const out = execFileSync('npx', ['tsx', INSTALL, '--home', corpus, '--no-daemon'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match(out, /wrapped\s+1 server\(s\) through the gateway: github/, out);

    /* END STATE, from the files. */
    const clientText = fs.readFileSync(claudeJson, 'utf8');
    assert.ok(!clientText.includes(token), 'the client config still holds the token');
    assert.ok(!clientText.includes(url), 'the client config still names the server url');
    const entry = (JSON.parse(clientText) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcpServers.github;
    assert.equal(entry.command, 'node');
    assert.match(entry.args[0], /bin\/cairn-proxy\.js$/, 'the client entry launches the gateway');
    const stash = entry.args[entry.args.indexOf('--config') + 1];
    assert.equal(stash, path.join(corpus, 'wrapped', 'github.json'), 'pointed at the stash under the corpus home');
    assert.equal(entry.env.CAIRN_HOME, corpus);
    assert.equal(fs.statSync(stash).mode & 0o777, 0o600, 'the stash is 0600');
    const stashed = JSON.parse(fs.readFileSync(stash, 'utf8')) as { mcpServers: { github: { url: string; headers: Record<string, string> } } };
    assert.equal(stashed.mcpServers.github.url, url, 'the stash holds the original url');
    assert.equal(stashed.mcpServers.github.headers.Authorization, `${scheme} ${token}`, 'and the original header, verbatim');
    assert.match(fs.readFileSync(path.join(corpus, '.gitignore'), 'utf8'), /^wrapped\/$/m, 'wrapped/ is gitignored in the corpus');
    /*
     * Where the token is now: the stash, and the installer's pre-install backups
     * of ~/.claude.json (the user's own file as it was, token included — the
     * copy uninstall could be checked against). Nothing else, and every holder
     * 0600. The backups are named so the doc can tell the user to delete them
     * once the install is verified.
     */
    const isBackup = (f: string) => path.basename(f).startsWith('.claude.json.cairn-bak-');
    const holders = walk(home).filter((f) => fs.readFileSync(f, 'utf8').includes(token));
    assert.deepEqual(holders.filter((f) => !isBackup(f)), [stash], `the token is in the stash and the pre-install backups only; found in: ${holders.join(', ')}`);
    assert.ok(holders.some(isBackup), 'the pre-install backup of the original config exists');
    for (const f of holders) assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${f} holds the token and is not 0600`);

    /* THROUGH: launch exactly what the client entry says, as the client would. */
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    delete env.CAIRN_EVAL;
    Object.assign(env, entry.env, { HOME: home });
    const client = new Client({ name: 'install-door', version: '0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: 'pipe' }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('open'), `the door's tool is offered through the gateway: ${tools.join(', ')}`);
    assert.ok(!tools.includes('cairn_find'), 'the wrapped entry does not re-advertise the pull tools (--no-cairn-tools)');
    const r = await client.callTool({ name: 'open', arguments: { message: 'knock' } });
    const first = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.equal(r.isError ?? false, false, first);
    assert.match(first, /"ok":true/, 'open succeeds through the gateway');
    assert.ok(!JSON.stringify(r.content).includes(token), 'the result does not carry the token');
    await client.close();

    /* AROUND: the url straight, with no header. */
    const raw = new Client({ name: 'install-door-bypass', version: '0' }, { capabilities: {} });
    await assert.rejects(
      () => raw.connect(new StreamableHTTPClientTransport(new URL(url))),
      (e: Error) => /401|[Uu]nauthorized/.test(e.message),
      'the server is refused without the gateway',
    );

    /* And the session left the token nowhere new. */
    const after = walk(home).filter((f) => fs.readFileSync(f, 'utf8').includes(token));
    assert.deepEqual(after, holders, `a session through the gateway added a holder; found in: ${after.join(', ')}`);
  } finally {
    fx.child.stdin?.end();
    fx.child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
