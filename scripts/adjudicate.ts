/**
 * Second-layer review of findings changed in a pull request.
 *
 *   npm run cairn:adjudicate -- cairn/0016-something.json
 *   npm run cairn:adjudicate -- --changed-against origin/main
 *
 * Layer one is pattern matching, which catches blunt phrasings and is
 * evadable by anyone who has read safety.ts. This layer asks models to
 * classify the submission instead, so the two fail on different axes.
 *
 * Runs in CI, because a check a contributor runs locally is a check an
 * attacker declines to run. A finding hand-written into a pull request never
 * touches /api/submit and never triggers a pre-commit hook.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { FindingSchema } from '../src/lib/cairn/schema';
import { PanelConfigSchema } from '../src/lib/cairn/panel';
import { adjudicate, decide, type Adjudication } from '../src/lib/cairn/adjudicate';
import { scanInjection, scanExecutable } from '../src/lib/cairn/safety';

function targets(): string[] {
  const i = process.argv.indexOf('--changed-against');
  if (i !== -1) {
    // execFileSync, not execSync: `base` is `origin/${{ github.base_ref }}` in
    // CI, and this runs on the runner holding the panel's API keys. audit.ts
    // was fixed for exactly this and its sibling was left behind — the same
    // shape cairn-0021 is about.
    const next = process.argv[i + 1];
    if (next !== undefined && next.startsWith('--')) {
      console.error('--changed-against needs a value');
      process.exit(2);
    }
    const base = next ?? 'origin/main';
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', 'cairn/'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.endsWith('.json') && fs.existsSync(f));
  }
  return process.argv.slice(2).filter((a) => a.endsWith('.json'));
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'panel.config.json'), 'utf8'));
  delete raw._comment;
  return PanelConfigSchema.parse(raw);
}

async function main() {
  const files = targets();
  if (files.length === 0) {
    console.log('no changed findings to review');
    return;
  }

  const cfg = loadConfig();
  // Members without a key are NOT filtered out. adjudicate() returns an error
  // for them, exactly as solicit() does, so they count against the quorum.
  //
  // Filtering first made `expected` the number of keys that happened to be
  // set, which is the same defect decide() exists to prevent, one level up: a
  // CI secret misconfiguration that left one of four keys populated turned a
  // four-reviewer panel into a one-reviewer panel whose single "clean" passed
  // as full quorum, and the log read like a healthy run.
  const withKeys = cfg.members.filter((m) => process.env[m.apiKeyEnv]);
  let failures = 0;

  for (const file of files) {
    const finding = FindingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(`\n${file}  (${finding.id})`);

    // Layer one, always available, no network required.
    const patterns = [
      ...scanInjection(JSON.stringify(finding)),
      ...scanExecutable(finding.check.command + '\n' + (finding.workaround ?? '')),
    ].filter((f) => f.severity === 'block');
    if (patterns.length) {
      console.error('  PATTERN LAYER: blocked');
      for (const f of patterns) console.error(`    ${f.pattern}: ${f.reason} — ${f.sample}`);
      failures++;
      continue;
    }
    console.log('  pattern layer: clean');

    // Layer two.
    if (withKeys.length === 0) {
      console.error('  REVIEW LAYER: no reviewer credentials configured.');
      console.error('    A submission cannot be cleared by a layer that did not run.');
      console.error('    Set a provider key, or merge only on deliberate human review.');
      failures++;
      continue;
    }

    const results: Adjudication[] = await Promise.all(
      cfg.members.map((m) => adjudicate(m, finding, cfg)),
    );
    // The denominator is the configured panel, not what replied and not what
    // happened to have credentials.
    const outcome = decide(results, cfg.members.length);

    for (const r of results) {
      if (r.error) console.log(`    ${r.reviewer}: error — ${r.error.slice(0, 90)}`);
      else console.log(`    ${r.reviewer}: ${r.verdict!.verdict}`);
    }
    if (!outcome.pass) {
      console.error(`  REVIEW LAYER: ${outcome.reason}`);
      for (const f of outcome.flagged) {
        for (const reason of f.verdict!.reasons) console.error(`    ${f.reviewer}: ${reason}`);
        for (const q of f.verdict!.quotedEvidence) console.error(`      quoted: ${q.slice(0, 120)}`);
      }
      failures++;
      continue;
    }
    console.log(`  review layer: ${outcome.reason}`);
  }

  console.log(`\n${files.length} reviewed · ${failures} held`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
