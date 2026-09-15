/**
 * The load-bearing door, from the documented steps alone.
 *
 * GATEWAY.md's "Load-bearing door" section says: put the server and its key in
 * the gateway's `--config`, point the agent's client config at the gateway and
 * nothing else, and the tool works through the gateway and not around it.
 * `npm run cairn:gateway-door` runs exactly that shape against
 * fixtures/mcp/keyed-echo.mjs and audits every place the key could have gone.
 * This spawns it the way the operator does and reads the verdict lines — then
 * audits the kept home itself with the key it chose, so the proof does not
 * rest on the script's own bookkeeping.
 *
 * No model, no network: the fixture and the corpus are in the repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const REPO = process.cwd();

test('cairn:gateway-door: the tool works through the gateway, is refused around it, and the key reaches nothing the agent reads', () => {
  const key = `door-test-${crypto.randomBytes(8).toString('hex')}`;
  const r = spawnSync('npx', ['tsx', 'scripts/gateway-door.ts', '--key', key], {
    cwd: REPO,
    env: { ...process.env, CAIRN_EVAL: '1' } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /PASS — the door holds/);
  assert.match(out, /ok +open succeeds through the gateway/);
  assert.match(out, /ok +open is REFUSED without the gateway/);
  assert.match(out, /ok +open is REFUSED with a wrong key/);
  assert.match(out, /ok +the call row names the tool and the argument NAME only/);
  assert.match(out, /ok +key present in exactly one place: the proxy's config/);
  assert.doesNotMatch(out, /FAIL +/);
  /* The script never prints the key, whatever it asserts about it. */
  assert.ok(!out.includes(key), 'the script printed the key');

  /* Audit the kept home ourselves: the ledger the session wrote, and the two configs. */
  const home = out.match(/home +(\S+)/)?.[1];
  assert.ok(home && fs.existsSync(path.join(home, 'data', 'retrievals')), `no kept ledger at ${home}`);
  const rows = fs
    .readdirSync(path.join(home!, 'data', 'retrievals'))
    .flatMap((f) => fs.readFileSync(path.join(home!, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean));
  assert.ok(rows.length > 0, 'no ledger rows');
  for (const row of rows) assert.ok(!row.includes(key), `key in a ledger row: ${row.slice(0, 120)}`);
  const call = rows.map((l) => JSON.parse(l) as { source: string; query: string; by: string }).find((x) => x.source === 'mcp-proxy:call');
  assert.ok(call, `no mcp-proxy:call row in ${rows.length} rows`);
  assert.equal(call!.query, 'open [args: message]', 'the call row carries the argument name, not its value');
  assert.equal(call!.by, 'gateway-door', 'attributed to the CAIRN_AGENT the client config set');
  assert.ok(!fs.readFileSync(path.join(home!, 'client.json'), 'utf8').includes(key), 'the client config holds the key');
  assert.ok(fs.readFileSync(path.join(home!, 'door.json'), 'utf8').includes(key), 'the proxy config should be the one place the key lives');
  fs.rmSync(home!, { recursive: true, force: true });
});
