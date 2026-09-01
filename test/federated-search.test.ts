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

  const withUpstreamKeys = confidence(signed, new Date(), s.keysFor(signed));
  const withLocalOnly = confidence(signed, new Date(), loadKeys());
  assert.ok(
    withUpstreamKeys > withLocalOnly,
    `resolving upstream keys must raise confidence (${withUpstreamKeys} vs ${withLocalOnly}); ` +
      'equal means the resolver is not reaching the verifier',
  );

  /*
   * Through retrieve(), not just confidence().
   *
   * Calling confidence() directly with two maps proves the maps differ. It
   * passes unchanged if buildIndex drops the resolver on the floor, which is
   * the seam that actually has to hold -- and the one a future caller can
   * silently stop threading.
   */
  const { retrieve } = await import(`../src/lib/cairn/retrieval?seam=${stamp}`);
  const query = `${signed.title} ${signed.reality}`.slice(0, 200);
  const ranked = retrieve(query, s.findings, { keysFor: s.keysFor, limit: 5 });
  const hit = ranked.find((h: { finding: { id: string } }) => h.finding.id === signed.id);
  assert.ok(hit, 'the signed upstream finding must be retrievable by its own text');
  assert.ok(
    Math.abs(hit.confidence - withUpstreamKeys) < 1e-9,
    `retrieve must carry the resolver to the index (${hit.confidence} vs ${withUpstreamKeys})`,
  );
});
