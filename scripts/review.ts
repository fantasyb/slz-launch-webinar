/**
 * cairn:review — everything that should happen to a finding before it lands.
 *
 *   npm run cairn:review -- --changed-against origin/main
 *   npm run cairn:review -- cairn/0041-something.json
 *
 * A corpus meant to get large is gated by review, and review by hand does not
 * scale — the fiftieth contributor's finding gets the attention the reader has
 * left, which is none. So the same battery runs on every submission, and the
 * contributor is told what is wrong in terms they can act on rather than a red
 * cross with a log to dig through.
 *
 * FIVE QUESTIONS, and they were scattered across four commands and a person
 * remembering to run them:
 *
 *   well-formed   cairn:lint          in CI already
 *   safe          cairn:adjudicate    in CI already — models classify it, so
 *                                     that layer and the pattern matcher fail
 *                                     on different axes
 *   already here  cairn:admit         NOT in CI, which is how a corpus ends up
 *                                     with fifty thin records of one trap
 *   worth having  the payoff check    NOT in CI — both routes shut, or it
 *                                     changes nothing (cairn-0034)
 *   checkable     the check command    NOT in CI — a finding whose check cannot
 *                                     run is a claim nobody can re-test
 *
 * Degrades honestly. The last three call a model, and a pull request from a
 * fork gets no repository secrets — which is exactly how an outsider makes a
 * first contribution. Without a key the lexical half still runs and says so.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const base = argv.includes('--changed-against') ? argv[argv.indexOf('--changed-against') + 1] : null;
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

function changedFindings(against: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', against, '--', 'cairn/'], {
    encoding: 'utf8',
  });
  return out.split('\n').filter((f) => f.endsWith('.json') && fs.existsSync(f));
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 22 }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const files = base ? changedFindings(base) : argv.filter((a) => a.endsWith('.json'));
const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };

if (files.length === 0) {
  say('\nNo findings added or changed. Nothing to review.\n');
  process.exit(0);
}

say(`## cairn review — ${files.length} finding${files.length === 1 ? '' : 's'}\n`);
if (!hasKey) {
  say('> No model available (a fork gets no secrets), so duplicate adjudication,');
  say('> the payoff check and the safety classifier did not run. What follows is');
  say('> the lexical half. **A human still has to read this.**\n');
}

let blocking = 0;

/* Corpus-wide and cheap, so it runs once rather than per file. */
const lint = run('npx', ['tsx', 'scripts/lint-corpus.ts']);
const lintErrors = (lint.out.match(/^error /gm) ?? []).length;
say(`**Well-formed** — ${lintErrors === 0 ? 'lint clean' : `${lintErrors} lint error(s)`}`);
if (lintErrors) {
  blocking += lintErrors;
  for (const l of lint.out.split('\n').filter((l) => l.startsWith('error')).slice(0, 8)) say(`  - ${l}`);
}
say();

for (const file of files) {
  const id = path.basename(file).slice(0, 10);
  say(`### ${id}\n`);

  /* Is it already here? The question that decides whether a corpus scales. */
  const admit = run('npx', ['tsx', 'scripts/admit.ts', file]);
  const dup = /RECOMMEND: do not add a record/.test(admit.out);
  const neighbours = admit.out.split('\n').filter((l) => /overlap\s+cairn-/.test(l)).slice(0, 3);
  if (dup) {
    blocking++;
    say('**Already recorded.** Add an observation to the existing finding instead —');
    say('one record with fifty attesters beats fifty thin records.\n');
    for (const l of admit.out.split('\n').filter((l) => /DUPLICATE|Suggested observation/.test(l))) say(`  ${l.trim()}`);
  } else if (neighbours.length) {
    say('**Closest existing records** (judge these before adding):\n');
    for (const l of neighbours) say(`  - ${l.trim()}`);
  } else {
    say('**Nothing close** in the corpus.');
  }
  say();

  /* Can anyone re-test the claim? */
  const finding = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    check?: { command?: string; manual?: boolean };
  };
  if (!finding.check?.command) {
    blocking++;
    say('**No check.** A claim nobody can re-run is not falsifiable.');
  } else if (finding.check.manual) {
    say('**Check is manual** — fine, but nobody will run it unattended.');
  } else {
    say('**Check is automatic** — `npm run cairn:verify` can re-test this.');
  }
  say();
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

/*
 * Exits non-zero only for things that are objectively wrong: malformed, no
 * check, or an adjudicated duplicate. "Probably not worth recording" is a
 * conversation, not a gate — a wrong DUPLICATE silently loses a real finding
 * and the person who wrote it never learns why.
 */
say(blocking ? `\n${blocking} blocking issue(s).\n` : '\nNothing blocking.\n');
process.exit(blocking ? 1 : 0);
