/**
 * cairn:doctor — ask the whole corpus what is true about THIS machine, now.
 *
 *   npm run cairn:doctor              # every applicable check, in parallel
 *   npm run cairn:doctor -- --all     # ignore preconditions, run everything runnable
 *
 * Every other memory system answers "what did somebody write down about this".
 * This one can answer "which of these failures is happening to you right now",
 * because a finding is not prose — it carries the command that decides it.
 *
 * Two different things fall out of running them all at once, and they are worth
 * separating:
 *
 *   A MACHINE PROFILE. Which known traps are live here. That is a real answer
 *   to "what is wrong with this environment", produced before anything has gone
 *   wrong, from a corpus that has never seen this machine.
 *
 *   A CORPUS HEALTH REPORT. Findings decay on a half-life the author guessed
 *   at, and decay is an assumption until somebody re-runs the check. Running
 *   all of them turns assumed decay into measured decay: a `fresh` finding
 *   whose check no longer fires is a claim the corpus is still asserting and
 *   the world has stopped agreeing with.
 *
 * The second is the one nobody else can do at all, and it is the honest test of
 * whether a decaying corpus actually works or just looks rigorous.
 *
 * This runs shell from the local corpus and inherits every constraint in
 * confirm.ts: local findings only, enforced by identity; manual checks skipped;
 * bounded time; nothing implicit. See that file's header for why.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { confirmCandidates, type Confirmation } from '../src/lib/cairn/confirm';
import { matchEnvironment } from '../src/lib/cairn/precondition';
import { standing, confidence } from '../src/lib/cairn/decay';
import { ExecutionRefused } from '../src/lib/cairn/policy';

const all = loadCorpus().filter((f) => f.status === 'active');
const ignorePreconditions = process.argv.includes('--all');

const runnable = all.filter((f) => {
  if (f.check.manual) return false;
  if (ignorePreconditions) return true;
  return !f.precondition?.length || matchEnvironment(f.precondition).matches;
});

console.log(
  `\n${all.length} active findings · ${runnable.length} with a check that can run here` +
    `${ignorePreconditions ? ' (--all: preconditions ignored)' : ''}\n`,
);

async function main() {
  const started = Date.now();
  /*
   * A policy refusal is an answer, not a crash. Dumping a stack trace at
   * somebody whose organisation has deliberately not enabled execution tells
   * them the tool is broken, when in fact it is doing exactly what they
   * asked.
   */
  let results: Confirmation[];
  try {
    results = await confirmCandidates(runnable, {
      max: runnable.length,
      timeoutMs: 30_000,
      concurrency: 6,
    });
  } catch (e) {
    if (e instanceof ExecutionRefused) {
      console.error(`\n${e.message}\n`);
      process.exit(3);
    }
    throw e;
  }
  const elapsed = Date.now() - started;

  const byId = new Map(all.map((f) => [f.id, f]));
  const fires = results.filter((r) => r.fired === 'fires');
  const quiet = results.filter((r) => r.fired === 'does-not-fire');
  const unclear = results.filter((r) => r.fired === 'inconclusive');

  if (fires.length) {
    console.log('LIVE ON THIS MACHINE');
    for (const r of fires) {
      const f = byId.get(r.id)!;
      console.log(`  ${r.id}  ${f.title}`);
      console.log(`      ${r.detail}`);
    }
  }

  if (quiet.length) {
    console.log('\nDID NOT REPRODUCE HERE');
    for (const r of quiet) console.log(`  ${r.id}  ${byId.get(r.id)!.title.slice(0, 66)}`);
  }

  if (unclear.length) {
    console.log('\nINCONCLUSIVE');
    for (const r of unclear) console.log(`  ${r.id}  ${r.detail}`);
  }

  /*
   * The part that is actually about the corpus rather than the machine.
   *
   * A finding still standing `fresh` whose check does not fire is the failure
   * mode this whole project is built to catch: a confident claim the world has
   * quietly stopped agreeing with. Decay alone cannot find it, because decay is
   * a timer, and a timer does not know anything.
   *
   * This is NOT automatically a refutation. A check that does not fire here may
   * simply mean the finding is about an environment this is not — which is what
   * `environment-specific` means and why the scope is on the finding. So the
   * report names them and stops; recording a verdict is a deliberate act with
   * `cairn:observe`, by a party willing to sign it.
   */
  const suspicious = quiet
    .map((r) => byId.get(r.id)!)
    .filter((f) => standing(f) === 'fresh')
    .filter((f) => !f.precondition?.length || matchEnvironment(f.precondition).matches);

  /*
   * A machine-readable line, emitted unconditionally.
   *
   * The quality guard parsed the human-readable slow-check section, which
   * doctor prints only when a check IS slow. With nothing slow there was no
   * line, the guard read zero, and a threshold of one millisecond passed --
   * a gate whose input selector returns nothing passing everything, which is
   * cairn-0028, occurring in the guard built to prevent regressions.
   *
   * Always emitted, whatever the result, so absence of a problem and absence
   * of a measurement can never look the same.
   */
  const slowestMs = results.reduce((m, r) => Math.max(m, r.ms), 0);
  console.log(
    `\nSUMMARY checks=${results.length} live=${fires.length} quiet=${quiet.length} ` +
      `inconclusive=${unclear.length} slowest_ms=${slowestMs} total_ms=${elapsed}`,
  );

  console.log('\n' + '-'.repeat(64));
  console.log(
    `${results.length} checks in ${(elapsed / 1000).toFixed(1)}s · ` +
      `${fires.length} live · ${quiet.length} quiet · ${unclear.length} inconclusive`,
  );

  /*
   * Checks too expensive to run unattended.
   *
   * The corpus asks for checks that are "cheap and hermetic" because another
   * agent will run them without watching. Measuring the whole corpus at once
   * is what makes a violation visible: one check takes 18 seconds -- it runs a
   * full framework build -- and accounts for 88% of the time to verify
   * everything. Seven others finish in under 10ms each.
   *
   * This is not a style complaint. An expensive check is one nobody runs, and
   * a finding whose check nobody runs decays on a timer forever without ever
   * being re-tested, which is the exact rot the half-life was meant to expose.
   * The cost shows up as a slow command and the consequence shows up months
   * later as a confident stale claim, so the two are worth connecting here.
   */
  const SLOW_MS = 5_000;
  const slow = results
    .filter((r) => r.ms >= SLOW_MS)
    .sort((a, b) => b.ms - a.ms);
  if (slow.length) {
    console.log(
      `\n${slow.length} check(s) took over ${SLOW_MS / 1000}s. A check nobody will run ` +
        'unattended is a\nfinding that decays forever without being re-tested:',
    );
    for (const r of slow) {
      console.log(`  ${r.id}  ${(r.ms / 1000).toFixed(1)}s  ${byId.get(r.id)!.title.slice(0, 46)}`);
    }
  }

  if (suspicious.length) {
    console.log(
      `\n${suspicious.length} finding(s) stand "fresh" but did not reproduce, with their\n` +
        'preconditions holding here. That is the gap decay cannot see. Worth a\n' +
        'deliberate re-observation rather than an assumption:',
    );
    for (const f of suspicious) {
      console.log(`  ${f.id}  confidence ${(confidence(f) * 100).toFixed(0)}%  ${f.title.slice(0, 52)}`);
      console.log(`      npm run cairn:verify ${f.id}`);
    }
  } else {
    console.log('\nNo finding contradicts its own standing here.');
  }
  console.log();
}

void main();
