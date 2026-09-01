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
import { SubmissionSchema, normalise, likelyDuplicates, slugify } from '../src/lib/cairn/submission';
import { FindingSchema } from '../src/lib/cairn/schema';
import { scanExecutable, scanInjection, scanSensitive, draftSurface } from '../src/lib/cairn/safety';
import { loadCorpus } from '../src/lib/cairn/load';
import { loadSearchable } from '../src/lib/cairn/federation';
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

/*
 * Scanned before anything else looks at it, and refused rather than
 * redacted. Evidence is error output, and error output carries hostnames,
 * home paths and tokens -- the writer may not have noticed, and once it is
 * committed it is in everybody's clone. A local write is MORE dangerous
 * here than the HTTP path, not less: nobody is reviewing it before it lands.
 */
const surface = draftSurface(submission.data as unknown as Record<string, unknown>);
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
const dupes = likelyDuplicates(submission.data.title, loadSearchable().findings);
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
const { finding } = normalise(submission.data, new Date(), `cairn-${num}`);

const checked = FindingSchema.safeParse(finding);
if (!checked.success) {
  console.error('\n  the finding did not validate after normalisation:\n');
  for (const i of checked.error.issues) console.error(`    ${i.path.join('.')}: ${i.message}`);
  console.error('');
  process.exit(2);
}

const root = installRoot();
const dir = homePath('cairn');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${num}-${slugify(submission.data.title)}.json`);
if (fs.existsSync(file)) {
  console.error(`\n  ${file} already exists. Nothing was written.\n`);
  process.exit(1);
}
fs.writeFileSync(file, `${JSON.stringify(checked.data, null, 2)}\n`);

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

console.log(`\n  recorded ${checked.data.id} in ${cairnHome()}`);
console.log(`    ${file}`);
console.log(`    ${checked.data.title}`);
for (const w of warned) console.log(`    ${w.trim()}`);
console.log(
  '\n  Unsigned, so it counts as one environment and cannot raise scope on its own.',
);
console.log('  Commit it to share it. To sign it: cairn:keygen, then cairn:sign.\n');
