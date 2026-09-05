/**
 * cairn:record — an agent writes a finding into its own corpus, from anywhere.
 *
 *   node bin/cairn-record.js --file finding.json
 *   node bin/cairn-record.js < finding.json
 *
 * Reading was portable and writing was not. `find`, `brief` and `sync` all
 * shipped as binaries that resolve their own install, while recording still
 * meant cd'ing into the checkout and running an npm script -- so a second
 * user could consult the corpus and never add to it. A ledger only readers
 * ever touch stops being a ledger.
 *
 * It takes the SAME submission shape as /api/contribute and runs the SAME
 * gates, deliberately, by calling the one function every door calls:
 * recordSubmission() in src/lib/cairn/recordFinding.ts. This file used to
 * carry its own copy of that sequence, and so did the MCP server, which is
 * how a corpus ends up with a clean half and a dirty half -- the dirty half
 * being whichever door was most convenient. What is left here is the part
 * only a command line has: arguments, exit codes, and the lint-after-write.
 *
 * What it does NOT do is sign. Signing needs a key, generating a key is a
 * decision about identity, and demanding one before the first contribution
 * is how a first contribution stops happening. An unsigned finding is worth
 * less -- it cannot raise scope -- and it is worth more than nothing, which
 * is what the alternative collects.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { recordSubmission } from '../src/lib/cairn/recordFinding';
import { cairnHome, installRoot } from '../src/lib/cairn/home';

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');
const force = args.includes('--force');

function usage(msg: string): never {
  console.error(`\n  ${msg}\n`);
  console.error('  usage: cairn-record --file <finding.json>   (or pipe the JSON on stdin)');
  console.error('  the JSON is a submission: title, claim, expectation, reality, check, by.');
  console.error('  --force records it anyway when a similar finding already exists.\n');
  process.exit(2);
}

let raw: string;
if (fileArg !== -1) {
  const file = args[fileArg + 1];
  if (!file) usage('--file needs a path');
  if (!fs.existsSync(file)) usage(`no such file: ${file}`);
  raw = fs.readFileSync(file, 'utf8');
} else if (!process.stdin.isTTY) {
  raw = fs.readFileSync(0, 'utf8');
} else {
  usage('nothing to record');
}

let parsedJson: unknown;
try {
  parsedJson = JSON.parse(raw);
} catch (e) {
  usage(`that is not JSON — ${(e as Error).message}`);
}

const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n');

// tsx emits CJS for this script, where top-level await is unavailable, so
// everything asynchronous runs inside main().
async function main() {
  /*
   * `origin: 'human'`: a person at a keyboard, recording a check they wrote
   * seconds ago. That is the one origin whose absentWhen the gate may run,
   * and only unless this machine's policy says strict -- see EXECUTION.md.
   */
  const outcome = await recordSubmission(parsedJson, { origin: 'human', force });
  if (!outcome.ok) {
    console.error(`\n${indent(outcome.message)}\n`);
    process.exit(outcome.message.startsWith('Not recordable') ? 2 : 1);
  }
  const file = outcome.file!;
  const finding = outcome.finding!;

  /*
   * Linted after writing, and REMOVED again if it does not pass.
   *
   * Schema validity is not the bar the corpus actually enforces: the
   * pre-commit hook and cairn-review.yml both run the linter, so a finding
   * that validates and fails lint is one a person cannot commit. Recording
   * used to stop at the schema and hand back exactly that -- a new
   * contributor's first finding, unrejectable at the point of writing and
   * unmergeable everywhere after. Better to refuse it here, while they still
   * have the context to fix it.
   */
  const root = installRoot();
  const lint = spawnSync('npx', ['tsx', path.join(root ?? '.', 'scripts', 'lint-corpus.ts')], {
    cwd: root ?? process.cwd(),
    env: { ...process.env, CAIRN_HOME: cairnHome() },
    encoding: 'utf8',
  });
  const lintOut = `${lint.stdout ?? ''}${lint.stderr ?? ''}`;
  const mine = (l: string) => l.includes(path.basename(file));
  /*
   * Exit 1 is errors, exit 2 is warnings only. Refuse on errors alone: the
   * first warning a new contributor earns is "unsigned", which they cannot
   * clear without generating a key -- the exact step this path deliberately
   * does not demand. Refusing on warnings would make a first contribution
   * impossible for the reason we chose not to require.
   */
  const myErrors = lintOut.split('\n').filter((l) => mine(l) && l.trim().startsWith('error'));
  if (lint.error || lint.status === null) {
    /* Lint could not RUN (npx missing, installRoot() null so the script path was
     * wrong). Do NOT delete the finding — the earlier code unlinked it and printed
     * an empty refusal list, losing the user's work for an infrastructure fault. */
    console.error('\n  recorded, but corpus lint could not run to verify it:');
    console.error(`    ${lint.error?.message ?? 'lint exited with no status'}`);
    console.error('  Run `npm run cairn:lint` yourself before committing.\n');
  } else if (lint.status === 1 && myErrors.length) {
    fs.unlinkSync(file);
    console.error('\n  refused — it does not pass corpus lint, so it could not be committed:\n');
    for (const line of myErrors) console.error(`    ${line.trim()}`);
    console.error('\n  Nothing was written. Fix those and record it again.\n');
    process.exit(1);
  } else if (lint.status === 1) {
    /* Errors exist ELSEWHERE in the corpus, not in this finding — keep it. */
    console.error('\n  recorded. NOTE: corpus lint reports errors elsewhere (not in this finding); fix them before committing.\n');
  }

  const warned = lintOut.split('\n').filter((l) => mine(l) && l.trim().startsWith('warn'));

  console.log(`\n  recorded ${finding.id} in ${cairnHome()}`);
  console.log(`    ${file}`);
  console.log(`    ${finding.title}`);
  for (const w of warned) console.log(`    ${w.trim()}`);
  /* Everything recordSubmission had to say after the first line: the tool hand-over, the gate, the signing note. */
  for (const line of outcome.message.split('\n').slice(1)) console.log(`  ${line}`);
  console.log('  Commit it to share it. To sign it: cairn:keygen, then cairn:sign.\n');
}

main();
