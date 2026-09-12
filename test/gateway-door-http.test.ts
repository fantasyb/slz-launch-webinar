/**
 * The load-bearing door, HTTP + bearer token, from the documented steps alone.
 *
 * GATEWAY.md's "Token-auth HTTP door" subsection says: put the server's `url`
 * and its bearer `headers` in the gateway's `--config`, point the agent's
 * client config at the gateway and nothing else, and the tool works through
 * the gateway and not around it. `npm run cairn:gateway-door-http` runs
 * exactly that shape against fixtures/mcp/keyed-http-echo.mjs and audits every
 * place the token could have gone. This spawns it the way the operator does,
 * reads the verdict lines, then audits the kept home itself with the token it
 * chose — so the proof does not rest on the script's own bookkeeping.
 *
 * No model, no network beyond loopback: the fixture and the corpus are in the
 * repository. The token is a fixture value generated here; nothing real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const REPO = process.cwd();

test('cairn:gateway-door-http: the tool works through the gateway, is refused around it, and the token reaches nothing the agent reads', () => {
  const token = `door-test-${crypto.randomBytes(8).toString('hex')}`;
  const r = spawnSync('npx', ['tsx', 'scripts/gateway-door.ts', '--http', '--key', token], {
    cwd: REPO,
    env: { ...process.env, CAIRN_EVAL: '1' } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /PASS — the door holds/);
  assert.match(out, /ok +open succeeds through the gateway/);
  assert.match(out, /ok +the server is REFUSED without the gateway/);
  assert.match(out, /ok +the server is REFUSED with a wrong token/);
  assert.match(out, /ok +the call row names the tool and the argument NAME only/);
  assert.match(out, /ok +key present in exactly one place: the proxy's config/);
  assert.doesNotMatch(out, /FAIL +/);
  /* The script never prints the token, whatever it asserts about it. */
  assert.ok(!out.includes(token), 'the script printed the token');

  /* Audit the kept home ourselves: everything the session wrote, and the two configs. */
  const home = out.match(/home +(\S+)/)?.[1];
  assert.ok(home && fs.existsSync(path.join(home, 'data', 'retrievals')), `no kept ledger at ${home}`);
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(home!)) {
    if (path.basename(f) === 'door.json') continue; /* the proxy's config: the one place */
    assert.ok(!fs.readFileSync(f, 'utf8').includes(token), `token in ${f}`);
  }
  const rows = fs
    .readdirSync(path.join(home!, 'data', 'retrievals'))
    .flatMap((f) => fs.readFileSync(path.join(home!, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l) as { source: string; query: string; by: string });
  const call = rows.find((x) => x.source === 'mcp-proxy:call');
  assert.ok(call, `no mcp-proxy:call row in ${rows.length} rows`);
  assert.equal(call!.query, 'open [args: message]', 'the call row carries the argument name, not its value');
  assert.equal(call!.by, 'gateway-door', 'attributed to the CAIRN_AGENT the client config set');
  const proxyConfig = JSON.parse(fs.readFileSync(path.join(home!, 'door.json'), 'utf8')) as { mcpServers: { door: { url?: string; headers?: Record<string, string> } } };
  assert.match(proxyConfig.mcpServers.door.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'the proxy config names the server by url');
  assert.equal(proxyConfig.mcpServers.door.headers?.Authorization, `Bearer ${token}`, 'the proxy config is the one place the token lives');
  fs.rmSync(home!, { recursive: true, force: true });
});
