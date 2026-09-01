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
 * gates, deliberately. Two ways in with two different bars is how a corpus
 * ends up with a clean half and a dirty half, and the dirty half is always
 * the convenient one.
 *
 * What it does NOT do is sign. Signing needs a key, generating a key is a
 * decision about identity, and demanding one before the first contribution
 * is how a first contribution stops happening. An unsigned finding is worth
 * less -- it cannot raise scope -- and it is worth more than nothing, which
 * is what the alternative collects.
 */
import fs from 'fs';
import path from 'path';
import { SubmissionSchema, normalise, likelyDuplicates, slugify, readsAsProse } from '../src/lib/cairn/submission';
import { FindingSchema } from '../src/lib/cairn/schema';
import { scanExecutable, scanInjection, scanSensitive, draftSurface } from '../src/lib/cairn/safety';
import { loadCorpus } from '../src/lib/cairn/load';
import { loadSearchable } from '../src/lib/cairn/federation';
import { checkFlaws } from '../src/lib/cairn/checkquality';
import { gate } from '../src/lib/cairn/gate';
import { homePath, cairnHome, installRoot } from '../src/lib/cairn/home';
import { spawnSync } from 'child_process';

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

const submission = SubmissionSchema.safeParse(parsedJson);
if (!submission.success) {
  console.error('\n  that submission is not recordable yet:\n');
  for (const i of submission.error.issues) {
    console.error(`    ${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  console.error('');
  process.exit(2);
}
/* Narrowed here: the guard above does not survive the function boundary below. */
const data = submission.data;

/*
 * Scanned before anything else looks at it, and refused rather than
 * redacted. Evidence is error output, and error output carries hostnames,
 * home paths and tokens -- the writer may not have noticed, and once it is
 * committed it is in everybody's clone. A local write is MORE dangerous
 * here than the HTTP path, not less: nobody is reviewing it before it lands.
 */
const surface = draftSurface(data as unknown as Record<string, unknown>);
const flags = [...scanExecutable(surface), ...scanInjection(surface), ...scanSensitive(surface)];
if (flags.length) {
  console.error('\n  refused — this must not be committed:\n');
  for (const f of flags) console.error(`    ${f.pattern.padEnd(24)} ${f.reason}\n      ${f.sample}`);
  console.error('\n  Take it out and record it again. Nothing was written.\n');
  process.exit(1);
}

/*
 * Against the corpus the reader actually searches, upstream included.
 * loadCorpus() is local only, so a near-copy of a shared finding was accepted
 * silently -- on the path that will produce the most records, and the exact
 * fifty-thin-records failure the duplicate gate exists to prevent.
 */
/*
 * A check that cannot decide anything is not a check.
 *
 * doctor reports a finding LIVE when its check exits zero, so a check that
 * exits zero regardless makes doctor report it live everywhere. Across the
 * first forty findings only four of nineteen runnable checks discriminated,
 * all written by an agent with the schema in front of it -- which is the one
 * measured failure mode of agent-written findings, and the reason this
 * refuses at the door rather than warning after.
 */
const flaws = checkFlaws({ ...data.check, manual: data.check.manual ?? readsAsProse(data.check.command) });
if (flaws.length && !force) {
  console.error('\n  refused — the check cannot decide whether this is happening:\n');
  for (const f of flaws) console.error(`    ${f.rule.padEnd(24)} ${f.detail}`);
  console.error(
    '\n  Make it exit non-zero when the trap is ABSENT, or set check.manual to true\n' +
      '  if nothing on the machine can tell. Nothing was written.\n',
  );
  process.exit(1);
}

const dupes = likelyDuplicates(data.title, loadSearchable().findings);
if (dupes.length && !force) {
  console.error('\n  already recorded — add an observation to the existing finding instead:\n');
  for (const d of dupes) console.error(`    ${d.id}  ${d.title}`);
  console.error('\n  If yours really is different, record it again with --force.\n');
  process.exit(1);
}

/*
 * The id comes from THIS corpus, which for a local write is the live one --
 * unlike the server, whose bundled copy is frozen at build time.
 */
const max = loadCorpus().reduce((m, f) => Math.max(m, parseInt(f.id.slice(6), 10)), 0);
const num = String(max + 1).padStart(4, '0');
const draft = normalise(data, new Date(), `cairn-${num}`).finding;

const checked = FindingSchema.safeParse(draft);
if (!checked.success) {
  console.error('\n  the finding did not validate after normalisation:\n');
  for (const i of checked.error.issues) console.error(`    ${i.path.join('.')}: ${i.message}`);
  console.error('');
  process.exit(2);
}
/* Narrowed here: the guard above does not survive the function boundary below. */
const finding = checked.data;

// tsx emits CJS for this script, where top-level await is unavailable, so the
// gate -- the only asynchronous step -- runs inside main(). Nothing above is async.
async function main() {
  /*
   * The runtime half of the gate, when the writer supplied a delta.
   *
   * The static rules catch a check that never decides anything. This catches
   * the ones that LOOK like they decide: run the check, apply the finding's own
   * absentWhen, run it again, and refuse if the answer did not move. Skipped
   * when no absentWhen was given -- an ungated finding still lands, because
   * demanding a delta for traps that have no on-machine remedy would refuse the
   * manual ones, and a corpus that only accepts what it can prove is a corpus
   * that loses the hardest findings.
   */
  if (finding.check.absentWhen && !finding.check.manual) {
    const verdict = await gate(finding);
    if (verdict.verdict === 'same-either-way') {
      console.error('\n  refused — the check does not distinguish the trap from its absence:\n');
      console.error(`    ${verdict.detail}`);
      console.error('\n  Nothing was written.\n');
      process.exit(1);
    }
    if (verdict.verdict === 'discriminates') {
      console.log(`\n  gate: ${verdict.detail}`);
    }
  }

  const root = installRoot();
  const dir = homePath('cairn');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${num}-${slugify(data.title)}.json`);
  if (fs.existsSync(file)) {
    console.error(`\n  ${file} already exists. Nothing was written.\n`);
    process.exit(1);
  }
  fs.writeFileSync(file, `${JSON.stringify(finding, null, 2)}\n`);

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
  if (lint.status === 1) {
    fs.unlinkSync(file);
    console.error('\n  refused — it does not pass corpus lint, so it could not be committed:\n');
    for (const line of lintOut.split('\n').filter(mine)) console.error(`    ${line.trim()}`);
    console.error('\n  Nothing was written. Fix those and record it again.\n');
    process.exit(1);
  }

  const warned = lintOut.split('\n').filter((l) => mine(l) && l.trim().startsWith('warn'));

  console.log(`\n  recorded ${finding.id} in ${cairnHome()}`);
  console.log(`    ${file}`);
  console.log(`    ${finding.title}`);
  for (const w of warned) console.log(`    ${w.trim()}`);
  console.log(
    '\n  Unsigned, so it counts as one environment and cannot raise scope on its own.',
  );
  console.log('  Commit it to share it. To sign it: cairn:keygen, then cairn:sign.\n');

}

main();
