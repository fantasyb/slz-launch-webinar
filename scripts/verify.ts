/**
 * Runs a finding's check and prints the criteria so you can judge the result.
 *
 * Deliberately does NOT decide the verdict for you. Matching output against
 * `confirmedIf` mechanically would invite findings written to be trivially
 * self-confirming; a reader has to look at what actually happened.
 *
 *   npm run cairn:verify cairn-0003
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { resolveFindingFile } from '../src/lib/cairn/resolve';
import { environmentSignature } from '../src/lib/cairn/schema';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';
import { scanExecutable } from '../src/lib/cairn/safety';
import { homePath } from '../src/lib/cairn/home';
import { assertExecutionAllowed, ExecutionRefused } from '../src/lib/cairn/policy';

const id = process.argv[2];
if (!id) {
  console.error('usage: npm run cairn:verify <cairn-NNNN>');
  process.exit(2);
}

const DIR = homePath('cairn');
let full: string;
try {
  full = resolveFindingFile(id, DIR);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const finding = FindingSchema.parse(JSON.parse(fs.readFileSync(full, 'utf8')));

const unresolved = finding.predictions.filter((p) => !p.outcome);
if (unresolved.length) {
  console.log(`\n${unresolved.length} unresolved prediction(s) will be settled by this run.`);
}
console.log(`\n${finding.id} — ${finding.title}\n`);
console.log(`claim: ${finding.claim}\n`);

if (finding.check.manual) {
  console.log('This check is marked manual. It needs a human, a specific host,');
  console.log('or a paid API, and will not be run automatically.\n');
  console.log(`  ${finding.check.command}\n`);
  process.exit(0);
}

/**
 * Corpus commands are not executed unless explicitly asked for.
 *
 * Pattern matching cannot decide whether a shell command is safe — five of
 * eight hand-written evasions pass the scanner, and no finite list closes
 * that. So the scanner is not asked to be a boundary. The command is printed,
 * a person or agent reads it, and execution requires --run. Carelessness is
 * caught by the scanner, malice by pull-request review, and neither has to be
 * perfect because nothing runs on its own.
 */
const flags = scanExecutable(finding.check.command);
console.log('COMMAND (from the corpus — read it before running it):\n');
console.log(`  ${finding.check.command}\n`);

if (flags.length) {
  console.log('FLAGGED:');
  for (const f of flags) console.log(`  [${f.severity}] ${f.pattern}: ${f.reason}`);
  console.log('');
}

if (!process.argv.includes('--run')) {
  console.log('Not executed. Re-run with --run once you have read the command.\n');
  console.log(`confirmed if: ${finding.check.confirmedIf}`);
  console.log(`refuted if:   ${finding.check.refutedIf}`);
  process.exit(0);
}

/*
 * The same gate as doctor, find --confirm and cairn:gate. This path executed
 * a corpus check behind a flag and consulted no policy at all, so a machine
 * that had deliberately not enabled execution ran one anyway if anybody typed
 * --run. A policy with an exception nobody documented is not a policy.
 */
try {
  assertExecutionAllowed(`the check for ${finding.id}`);
} catch (e) {
  if (e instanceof ExecutionRefused) {
    console.error(`\n${e.message}\n`);
    process.exit(3);
  }
  throw e;
}

if (flags.some((f) => f.severity === 'block')) {
  console.error('Refusing to run: this command matches a pattern that should never appear');
  console.error('in a corpus check. Report it rather than running it.');
  process.exit(1);
}

let output: string;
let code = 0;
try {
  // Merge stderr into stdout: for many findings the diagnostic that decides
  // the verdict is written to stderr, and execSync would otherwise drop it.
  // Written to a script and run as a file, rather than wrapped in `( ... )`.
  //
  // The subshell wrapper broke any command containing a heredoc: a contributor
  // wrote a perfectly good check using `python3 - <<'EOF'` and it died with
  // "unexpected end of file", which reads as the check failing rather than as
  // the harness mangling it. Multi-line commands, heredocs and trailing
  // comments all survive a real script file.
  const scriptFile = path.join(os.tmpdir(), `cairn-check-${process.pid}.sh`);
  // `exec 2>&1` inside the script, since execFileSync returns stdout only and
  // the diagnostic that decides the verdict is very often on stderr. The old
  // subshell wrapper did this with `( ... ) 2>&1`; moving to a script file
  // dropped it, and cairn-0001's decisive "CONNECT tunnel failed, response
  // 403" silently vanished from the output while exit=56 still showed.
  fs.writeFileSync(scriptFile, `exec 2>&1\n${finding.check.command}\n`, { mode: 0o700 });
  try {
    output = execFileSync('/bin/bash', [scriptFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      // SIGTERM is ignorable: `trap '' TERM; sleep 100000` outlived the timeout.
      killSignal: 'SIGKILL',
    });
  } finally {
    try {
      fs.unlinkSync(scriptFile);
    } catch {
      /* best effort */
    }
  }
} catch (e) {
  const err = e as { stdout?: string; stderr?: string; status?: number };
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  code = err.status ?? 1;
}

console.log('--- output ---');
console.log(output.trim() || '(no output)');
console.log(`--- exit ${code} ---\n`);
console.log(`confirmed if: ${finding.check.confirmedIf}`);
console.log(`refuted if:   ${finding.check.refutedIf}\n`);
if (finding.scope === 'universal') {
  console.log(
    `scope: universal, currently standing on ${
      new Set(
        finding.observations
          .filter((o) => o.verdict === 'confirmed' && o.environment)
          .map((o) => environmentSignature(o.environment!)),
      ).size
    } environment(s).`,
  );
  console.log('A confirmation from a new environment is the most valuable result here.\n');
} else {
  console.log(`scope: environment-specific — ${finding.appliesTo ?? ''}\n`);
}
if (unresolved.length) {
  console.log('Then set `outcome` and `resolvedAt` on each unresolved prediction.');
  console.log('Never edit `priorConfirmed` or `reasoning` — a forecast revised after');
  console.log('the fact measures nothing.\n');
}
console.log('Judge the result yourself, then record what you saw:\n');
console.log(
  `  CAIRN_KEY=<id> CAIRN_AGENT=<you> npm run cairn:observe -- ${finding.id} <confirmed|refuted|inconclusive> "what you saw"\n`,
);
console.log('That signs and appends it. The shape, for reference:\n');
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      by: '<your agent identifier>',
      verdict: 'confirmed | refuted | inconclusive',
      note: '<what you actually saw>',
      environment: {
        os: process.platform,
        arch: process.arch,
        runtime: `node ${process.version}`,
        note: '<anything else that would change the result>',
      },
    },
    null,
    2,
  ),
);
