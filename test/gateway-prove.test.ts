/**
 * The install path, from the documented steps alone.
 *
 * GATEWAY.md's INSTALL section tells a person to paste five lines that launch
 * `cairn-proxy --config <their mcp.json>`. `npm run cairn:gateway-prove` runs
 * exactly that shape against the records fixture with the trial corpus, calls
 * the tool the corpus has a finding about, and then runs `cairn:report` on the
 * home it wrote to. This spawns it the way the operator does and reads the
 * verdict lines, because the property is "the documented command proves it",
 * not "some internal function would".
 *
 * No model, no network: the fixture and the corpus are in the repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO = process.cwd();

test('cairn:gateway-prove: the --config install shape delivers a finding on the result, and cairn:report counts it', () => {
  const r = spawnSync(
    'npx',
    [
      'tsx', 'scripts/gateway-smoke.ts',
      '--server', `node ${path.join(REPO, 'fixtures', 'mcp', 'records.mjs')}`,
      '--name', 'records',
      '--corpus', path.join(REPO, 'fixtures', 'trials', 'gateway', 'corpus'),
      '--call', 'query_records',
      '--args', '{"object":"Contact","filter":{"status":"churned"},"limit":1000}',
    ],
    { cwd: REPO, env: { ...process.env, CAIRN_EVAL: '1' } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 180_000 },
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /PASS — the gateway is transparent to this server, and it delivered\./);
  /* The transparency arms still hold under the config shape. */
  assert.match(out, /ok +every upstream tool survives, names untouched/);
  assert.match(out, /ok +query_records: the upstream's own result comes first and intact/);
  /* The finding rode, labelled, and the note is in the transcript. */
  assert.match(out, /ok +a finding naming this tool rides on the result +cairn-0001/);
  assert.match(out, /from your Cairn corpus, not from this tool/);
  /* And the report saw it: a row for the tool with the finding counted, served on the result surface. */
  assert.match(out, /ok +the report no longer says "recorded nothing yet"/);
  assert.match(out, /ok +served on the result surface +result [1-9]/);
  assert.doesNotMatch(out, /FAIL +/);

  /* The home it used is printed and kept, so the report can be re-run by hand against the same rows. */
  const home = out.match(/CAIRN_HOME=(\S+)/)?.[1];
  assert.ok(home && fs.existsSync(path.join(home, 'data', 'retrievals')), `no kept ledger at ${home}`);
  const rows = fs
    .readdirSync(path.join(home!, 'data', 'retrievals'))
    .flatMap((f) => fs.readFileSync(path.join(home!, 'data', 'retrievals', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { source: string; by: string; query: string; returned: Array<{ id: string }> }));
  const served = rows.find((x) => x.source === 'mcp-proxy:result');
  assert.ok(served, `no mcp-proxy:result row in ${rows.map((x) => x.source).join(', ')}`);
  assert.equal(served!.by, 'gateway-smoke', 'attributed to the CAIRN_AGENT the arm set');
  assert.equal(served!.returned[0].id, 'cairn-0001');
  /* CAIRN_EVAL was set on this test's own environment and must not have silenced the arm under test. */
  fs.rmSync(home!, { recursive: true, force: true });
});
