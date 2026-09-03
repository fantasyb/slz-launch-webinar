/**
 * The documentation must not state numbers the corpus contradicts.
 *
 * This has happened twice: the homepage rendered "4 excluded, 5 of them",
 * which cannot describe any set, and the README advertised a Brier score for
 * a forecast that is not scored. Both were written by hand beside code that
 * computed the real value. Prose drifts; a test does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { loadCorpus } from '../src/lib/cairn/load';
import {
  ledgerIntegrity,
  allPredictions,
  EXCLUSION_REASONS,
} from '../src/lib/cairn/calibration';

const README = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

test('the README ledger count matches the corpus', () => {
  const m = README.match(/current count is (\d+) forecasts? recorded and (\d+) scored/i);
  assert.ok(m, 'the README must state the ledger count in a checkable form');
  const l = ledgerIntegrity(loadCorpus());
  assert.equal(Number(m[1]), l.total, 'recorded count in README disagrees with the corpus');
  assert.equal(Number(m[2]), l.scored, 'scored count in README disagrees with the corpus');
});

test('the README quotes no Brier score while none is earned', () => {
  const l = ledgerIntegrity(loadCorpus());
  if (l.scored > 0) return; // once something is scored, quoting a number is fair
  const quoted = README.match(/Brier\s+\d+\.\d+/i);
  assert.equal(
    quoted,
    null,
    `README quotes "${quoted?.[0]}" but zero forecasts are scored`,
  );
});

test('no page hardcodes a ledger count in prose', () => {
  // The counts must be interpolated from ledgerIntegrity, not written out.
  // "all four of my own" outlived the ledger having four of anything.
  const pages = ['src/app/page.tsx', 'src/app/skill.md/route.ts'];
  for (const file of pages) {
    // Comments are stripped first: this check is about what renders, and it
    // flagged the very comment explaining why the check exists.
    const text = fs
      .readFileSync(path.join(process.cwd(), file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const spelled = text.match(
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of\s+(?:my|the)\s+own|forecasts?|predictions?)\b/i,
    );
    assert.equal(spelled, null, `${file} spells out a count: "${spelled?.[0]}"`);
  }
});

/**
 * The third instance of the same class was not an arithmetic error: the total
 * was right and the reasons under it accounted for five of nine, because the
 * page named two of the seven ways a forecast fails to score. Both tests
 * below are structural — they hold whatever the corpus contains, and they
 * fail if a new exclusion rule is added to isScorableIn without a matching
 * reason in exclusionReason.
 */
test('the exclusion reasons partition the excluded set', () => {
  const l = ledgerIntegrity(loadCorpus());
  const summed = l.exclusions.reduce((a, e) => a + e.count, 0);
  assert.equal(
    summed,
    l.total - l.scored,
    `exclusion reasons account for ${summed} of ${l.total - l.scored} excluded forecasts`,
  );
});

test('every excluded prediction carries exactly one reason', () => {
  for (const p of allPredictions(loadCorpus())) {
    if (p.scorable) {
      assert.equal(p.excludedBecause, null, `${p.findingId}/${p.by} scores but names a reason`);
    } else {
      assert.ok(
        p.excludedBecause && EXCLUSION_REASONS.includes(p.excludedBecause),
        `${p.findingId}/${p.by} is excluded with no reason`,
      );
    }
  }
});

test('the homepage does not enumerate exclusion reasons in prose', () => {
  // The reasons must come from integrity.exclusions. Naming a status in the
  // rendered text is how a list of two came to stand for a partition of seven.
  const text = fs
    .readFileSync(path.join(process.cwd(), 'src/app/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const named = text.match(/integrity\.(unanchored|legacyEncoding|broken|sealed|self)\b/);
  assert.equal(
    named,
    null,
    `the homepage renders integrity.${named?.[1]} directly instead of the partition`,
  );
});

/**
 * The repository carries two licenses for two different assets, and the split
 * only works if it is stated in one place and agreed with everywhere else.
 * package.json is the file tooling reads; NOTICE is the file people read.
 * They drifting apart is how a project ends up with an SPDX identifier that
 * contradicts its own LICENSE.
 */
test('the license files exist and agree with package.json', () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'Apache-2.0', 'package.json must declare the code license');

  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License\s+Version 2\.0/, 'LICENSE must be Apache-2.0');

  const corpus = fs.readFileSync(path.join(root, 'LICENSE-CORPUS'), 'utf8');
  assert.match(corpus, /SPDX-License-Identifier: CC-BY-4\.0/);

  const notice = fs.readFileSync(path.join(root, 'NOTICE'), 'utf8');
  for (const required of ['Apache License 2.0', 'Creative Commons Attribution 4.0']) {
    assert.ok(notice.includes(required), `NOTICE must name ${required}`);
  }
});

test('every corpus file is covered by the corpus license', () => {
  // LICENSE-CORPUS names the paths it applies to. A new corpus directory that
  // nobody adds there is code-licensed by default, which is the wrong terms
  // and, worse, a silent change of terms.
  const corpus = fs.readFileSync(path.join(process.cwd(), 'LICENSE-CORPUS'), 'utf8');
  const dirs = ['cairn/', 'research/panel-runs/'].filter((d) =>
    fs.existsSync(path.join(process.cwd(), d)),
  );
  for (const d of dirs) {
    assert.ok(corpus.includes(d), `LICENSE-CORPUS does not cover ${d}`);
  }
});

/**
 * Every launcher's tsx fallback must name its own script.
 *
 * cairn-brief.js and cairn-sync.js were both copied from cairn-find.js and
 * kept its entrypoint, so on a fresh clone -- before `cairn:build-cli` has
 * run, which is exactly a first-time user's state -- `cairn-brief` printed a
 * find listing and `cairn-sync` exited 2 with a usage message. The bundled
 * path was correct in both, so no test and no manual run caught it: the bug
 * was reachable only by someone who had never built anything, which is
 * everyone the tool is being handed to.
 */
test('each launcher launches its own target, and that target exists', () => {
  /*
   * The bundle name and the fallback script name used to be written out
   * separately in every launcher, and two of them -- brief and sync -- both
   * spawned find.ts. One name now, in one place, so they cannot disagree;
   * this checks the name is right and that both files it implies are real,
   * which the old pair of regexes could not.
   */
  const expected: Record<string, string> = {
    'cairn-find.js': 'find',
    'cairn-brief.js': 'brief',
    'cairn-sync.js': 'sync',
    'cairn-record.js': 'record',
    'cairn-mcp.js': 'mcp-server',
    'cairn-proxy.js': 'mcp-proxy',
    'cairn-sleep.js': 'sleep',
  };
  for (const [launcher, target] of Object.entries(expected)) {
    const src = fs.readFileSync(path.join(process.cwd(), 'bin', launcher), 'utf8');
    const named = src.match(/launch\('([a-z-]+)'\)/)?.[1];
    assert.equal(named, target, `${launcher} launches ${named}, not ${target}`);
    assert.ok(
      fs.existsSync(path.join(process.cwd(), 'scripts', `${target}.ts`)),
      `${launcher} names scripts/${target}.ts, which does not exist`,
    );
  }
  const launchers = fs.readdirSync(path.join(process.cwd(), 'bin')).filter((f) => f.startsWith('cairn-'));
  assert.deepEqual(launchers.sort(), Object.keys(expected).sort(), 'a new launcher was added without a target here');
});

/**
 * The refresh advice must name a command the reader can actually run.
 *
 * stalenessNote said `npm run cairn:sync` unconditionally. The reader who
 * most needs it is by definition working in their own project, where npm
 * resolves nothing -- so the tool's one piece of unprompted advice, given at
 * the exact moment of use, named a command that fails.
 */
test('the staleness note names a runnable command from a foreign directory', async () => {
  const { syncCommand } = await import('../src/lib/cairn/freshness');
  const inRepo = syncCommand();
  assert.equal(inRepo, 'npm run cairn:sync', 'inside the checkout, the npm script is the idiom');

  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-cwd-'));
  const prior = process.cwd();
  try {
    process.chdir(elsewhere);
    const away = syncCommand();
    assert.notEqual(away, 'npm run cairn:sync', 'npm resolves nothing from another project');
    assert.match(away, /^node .*bin[/\\]cairn-sync\.js$/);
    assert.ok(fs.existsSync(away.slice('node '.length)), 'and the path it names must exist');
  } finally {
    process.chdir(prior);
  }
});

test('--quiet suppresses the preflight miss message', () => {
  const run = (args: string[]) =>
    execFileSync('node', [path.join(process.cwd(), 'bin/cairn-find.js'), ...args], {
      encoding: 'utf8',
    }).trim();
  assert.match(run(['--preflight', 'totally-unknown-program-xyz']), /nothing known about/);
  assert.equal(run(['--preflight', '--quiet', 'totally-unknown-program-xyz']), '');
  // And a real trigger still speaks under --quiet.
  assert.match(run(['--preflight', '--quiet', 'playwright install']), /cairn-\d{4}/);
});

/**
 * The format is a first-class output, not an implementation detail of the
 * gateway: spec/finding.schema.json is what somebody who takes neither the
 * gateway nor the ranker validates against, and it is generated from the
 * zod definition the loaders enforce. Drift between them is a red build.
 */
test('spec/finding.schema.json is generated from the schema the code enforces', () => {
  execFileSync('npx', ['tsx', 'scripts/spec.ts', '--check'], { cwd: process.cwd(), stdio: 'pipe' });
});

test('cairn:conform accepts the corpus shape and refuses a malformed finding', () => {
  const out = execFileSync('npx', ['tsx', 'scripts/conform.ts', 'fixtures/trials/gateway/corpus/cairn'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.match(out, /2 conform, 0 malformed/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-conform-'));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'cairn-0001', title: 'no claim' }));
  let status = 0;
  try {
    execFileSync('npx', ['tsx', 'scripts/conform.ts', dir], { cwd: process.cwd(), stdio: 'pipe' });
  } catch (e) {
    status = (e as { status: number }).status;
  }
  assert.equal(status, 1, 'a malformed finding exits 1');
});
