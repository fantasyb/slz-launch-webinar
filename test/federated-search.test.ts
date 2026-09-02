/**
 * Search reaches upstream corpora, and verifies them against the right keys.
 *
 * Two defects lived here together, and each hid the other. loadCorpus() reads
 * only the local directory, and loadFederated() was consumed by the
 * federation web page and by `observe` -- so `find` and `brief`, the only two
 * things anybody runs, never saw an upstream finding. A personal corpus with
 * forty findings cached from its upstream answered "No corpus found", which
 * made the whole own-corpus-plus-upstream design a page on a website.
 *
 * The second defect only becomes reachable once the first is fixed: an
 * upstream finding's observations are signed by UPSTREAM keys, which
 * keys.ts deliberately excludes from loadKeys(). Searched without a
 * per-finding key map, every federated attestation reads as forged, and the
 * findings that have been vouched for hardest score the lowest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const REPO = process.cwd();

/** A corpus of one finding, subscribed to this repository as an upstream. */
function personalCorpus(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-fed-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  const donor = JSON.parse(
    fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'),
  );
  fs.writeFileSync(
    path.join(home, 'cairn', '9001-local-only.json'),
    JSON.stringify(
      {
        ...donor,
        id: 'cairn-9001',
        title: 'a finding that exists only in this personal corpus',
        scope: 'environment-specific',
        observations: [
          {
            by: 'second-user',
            at: '2026-09-01T00:00:00.000Z',
            verdict: 'confirmed',
            note: 'Recorded locally, signed by nobody.',
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(home, 'cairn.config.json'),
    JSON.stringify({ origin: 'https://second-user.example', upstreams: [{ name: 'shared', source: REPO }] }),
  );
  execFileSync('npx', ['tsx', 'scripts/federate.ts'], {
    cwd: REPO,
    env: { ...process.env, CAIRN_HOME: home },
    stdio: 'ignore',
  });
  return home;
}

/*
 * CAIRN_HOME is process-wide and cairnHome() memoises it, so a test that
 * sets it and walks away decides where every later test in this file looks.
 * Restored explicitly rather than relying on the runner isolating files.
 */
const PRIOR_HOME = process.env.CAIRN_HOME;
function restoreHome() {
  if (PRIOR_HOME === undefined) delete process.env.CAIRN_HOME;
  else process.env.CAIRN_HOME = PRIOR_HOME;
}

test('one search spans the local corpus and its upstreams', async (t) => {
  t.after(restoreHome);
  const home = personalCorpus();
  process.env.CAIRN_HOME = home;
  const { loadSearchable } = await import(`../src/lib/cairn/federation?fed=${Date.now()}`);
  const { findings } = loadSearchable();

  const local = findings.filter((f: { upstreamName?: string }) => !f.upstreamName);
  const upstream = findings.filter((f: { upstreamName?: string }) => f.upstreamName);
  assert.equal(local.length, 1, 'the personal corpus holds exactly one finding');
  assert.ok(upstream.length > 1, 'upstream findings must be searchable, not just displayable');

  // Namespaced for display, native underneath: rewriting the id would
  // invalidate every upstream signature, since confidence verifies against it.
  for (const f of upstream) {
    assert.match(f.displayId, /^shared:cairn-\d{4}$/);
    assert.match(f.id, /^cairn-\d{4}$/);
    assert.ok(f.upstreamOrigin, 'an upstream finding must name where it came from');
  }
});

test('a federated finding is verified against its own upstream keys', async (t) => {
  t.after(restoreHome);
  const home = personalCorpus();
  process.env.CAIRN_HOME = home;
  const stamp = Date.now();
  const { loadSearchable } = await import(`../src/lib/cairn/federation?keys=${stamp}`);
  const { loadKeys } = await import(`../src/lib/cairn/keys?keys=${stamp}`);
  const { confidence } = await import(`../src/lib/cairn/decay?keys=${stamp}`);

  const s = loadSearchable();
  assert.equal(loadKeys().size, 0, 'the personal corpus publishes no keys of its own');

  const signed = s.findings.find(
    (f: { upstreamName?: string; observations: { signature?: unknown }[] }) =>
      f.upstreamName && f.observations.some((o) => o.signature),
  );
  assert.ok(signed, 'the fixture upstream must carry at least one signed observation');
  assert.ok(signed.keys && signed.keys.size > 0, 'an upstream finding must carry its own key map');

  /*
   * No resolver is passed anywhere below. The finding carries its keys, so
   * every consumer agrees by construction rather than by remembering -- which
   * is the whole point of moving the data onto the object.
   */
  const withOwnKeys = confidence(signed, new Date());
  const withLocalOnly = confidence({ ...signed, keys: undefined }, new Date(), loadKeys());
  assert.ok(
    withOwnKeys > withLocalOnly,
    `a finding's own keys must verify its observations (${withOwnKeys} vs ${withLocalOnly})`,
  );

  const { retrieve } = await import(`../src/lib/cairn/retrieval?seam=${stamp}`);
  const query = `${signed.title} ${signed.reality}`.slice(0, 200);
  const hit = retrieve(query, s.findings, { limit: 5 }).find(
    (h: { finding: { id: string } }) => h.finding.id === signed.id,
  );
  assert.ok(hit, 'the signed upstream finding must be retrievable by its own text');
  assert.ok(
    Math.abs(hit.confidence - withOwnKeys) < 1e-9,
    `retrieve must reach the same verdict as confidence (${hit.confidence} vs ${withOwnKeys})`,
  );

  /*
   * And the serialising path must agree with the ranking path. /api/search
   * ranked an upstream hit through the index and serialised it through
   * summarise, which defaulted to local keys -- one response, two
   * confidences for the same finding.
   */
  const { summarise } = await import(`../src/lib/cairn/load?seam=${stamp}`);
  const summary = summarise(signed);
  assert.match(summary.detail, /^\/api\/findings\/shared:/, 'an upstream id must not link to a local one');
  assert.ok(
    Math.abs(summary.derived.confidence - Number(withOwnKeys.toFixed(3))) < 1e-9,
    `summarise must agree with the ranker (${summary.derived.confidence} vs ${withOwnKeys})`,
  );
});

/**
 * A private finding cannot reach a published bundle.
 *
 * Two kinds of record get written in the same session: one about an
 * organisation's own state, which nobody outside can act on and which must
 * never leave, and one about how a platform behaves for everyone, which is
 * the reason to publish at all. Telling people to sort them by hand at
 * publish time means it gets done once and then not.
 *
 * So the filter is in the bundle builder, and the default is private —
 * because the failure mode of defaulting the other way is publishing
 * somebody's org data, and there is no way to unpublish it.
 */
test('federationBundle omits private findings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-vis-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  fs.writeFileSync(
    path.join(home, 'cairn.config.json'),
    JSON.stringify({ origin: 'https://x.example', upstreams: [] }),
  );
  const donor = JSON.parse(
    fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'),
  );
  for (const [id, vis] of [['0001', 'private'], ['0002', 'shared']] as const) {
    fs.writeFileSync(
      path.join(home, 'cairn', `${id}-x.json`),
      JSON.stringify({ ...donor, id: `cairn-${id}`, title: `a ${vis} finding`, visibility: vis }),
    );
  }
  /*
   * A subprocess, because loadCorpus memoises for the life of a process and
   * a query-string import buster only busts the module it names. An in-process
   * version of this passed with an empty bundle, which would have read as the
   * filter working.
   */
  const out = execFileSync(
    'npx',
    ['tsx', '-e', "import {federationBundle} from './src/lib/cairn/federation';console.log(JSON.stringify(federationBundle().findings.map(f=>f.id)))"],
    { cwd: REPO, env: { ...process.env, CAIRN_HOME: home }, encoding: 'utf8' },
  ).trim();
  assert.deepEqual(JSON.parse(out), ['cairn-0002'], 'only the shared finding may be published');
});

test('a finding with no visibility set is private', async () => {
  const { FindingSchema } = await import('../src/lib/cairn/schema');
  const donor = JSON.parse(
    fs.readFileSync(path.join(REPO, 'cairn', fs.readdirSync(path.join(REPO, 'cairn'))[0]), 'utf8'),
  );
  delete donor.visibility;
  assert.equal(FindingSchema.parse(donor).visibility, 'private');
});
