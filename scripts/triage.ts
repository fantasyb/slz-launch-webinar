/**
 * cairn:triage — drain the candidate queue whenever this machine can, and never
 * more than it should.
 *
 *   npm run cairn:triage            # run the gate on every ready candidate, settle each
 *   npm run cairn:triage -- --status   # just report the queue and the yield ledger
 *
 * TWO JOBS, ONE MECHANICAL, ONE NOT. Turning a candidate into a finding needs a
 * check written (judgment — the triage agent's step, on a live box) and then that
 * check RUN as the one-machine delta (mechanical — this script). This script owns
 * the mechanical half: for every candidate that already carries a check, it runs
 * the gate and routes the verdict (admit / reject / defer), which is safe because
 * the gate is the same vetted execution path cairn:verify uses. Candidates without
 * a check are reported, not touched — they wait for the agent to write one.
 *
 * WHEN IT CAN, AND ONLY THEN. Running a check is executing shell that came out of
 * a corpus, so it is gated by the execution policy (policy.ts), OFF by default and
 * enabled per-machine per-corpus by a reviewed file outside the corpus. If it is
 * off, this reports the waiting queue and changes nothing — no candidate is even
 * defer-counted, because "this machine may not run checks" is not "this trap is not
 * live here." Forward progress resumes the moment execution is enabled. And a trap
 * that is not live on THIS machine defers (bounded — see triage.ts), so the queue
 * drains across the machines that can settle each candidate, and nothing waits
 * forever.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { homePath, cairnHome } from '../src/lib/cairn/home';
import { executionPolicy, policyPath } from '../src/lib/cairn/policy';
import { gate } from '../src/lib/cairn/gate';
import { pendingCandidates, hasCheck, settle, routeVerdict, yieldSummary } from '../src/lib/cairn/triage';
import { sealAndCommit } from '../src/lib/cairn/autoseal';
import type { Finding } from '../src/lib/cairn/schema';

const argv = process.argv.slice(2);
const STATUS = argv.includes('--status');

function draftsDir(): string | null {
  const i = argv.indexOf('--home');
  const explicit = i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  if (explicit) return path.join(explicit.startsWith('~') ? path.join(os.homedir(), explicit.slice(1)) : explicit, 'drafts');
  try {
    return homePath('drafts');
  } catch {
    return null;
  }
}

/** The minimal shape gate() reads out of a finding: its check and preconditions. */
function asFinding(data: Record<string, unknown>): Finding {
  return { check: data.check, precondition: Array.isArray(data.precondition) ? data.precondition : [] } as unknown as Finding;
}

function reportYield(dir: string): void {
  const y = yieldSummary(dir);
  const pending = pendingCandidates(dir).length;
  console.log(
    `\n  queue: ${pending} pending` +
      `\n  settled: ${y.settled}  (admitted ${y.admitted}, rejected ${y.rejected}, kept as leads ${y.lead})` +
      `\n  deferrals so far: ${y.deferred}` +
      (y.admitRate === null ? '' : `\n  admit-rate: ${(y.admitRate * 100).toFixed(0)}%  — watch this before growing volume`),
  );
}

async function main(): Promise<void> {
  const dir = draftsDir();
  console.log('\ncairn:triage — draining what this machine can settle');
  console.log('='.repeat(60));
  if (!dir) {
    console.error('  no corpus home resolvable (set CAIRN_HOME or pass --home)');
    process.exit(2);
  }

  if (STATUS) {
    reportYield(dir);
    console.log();
    return;
  }

  const pending = pendingCandidates(dir);
  if (!pending.length) {
    console.log('  queue empty — nothing to triage.');
    return;
  }

  if (!executionPolicy().enabled) {
    /* Not "this trap is not live" — "this machine may not run checks at all". So
     * we do not defer-count anyone; we report and stop. Progress resumes the
     * moment execution is enabled for this corpus. */
    console.log(
      `  ${pending.length} candidate(s) waiting, but execution is OFF for ${cairnHome()}.\n` +
        `  Triage runs the one-machine delta, which is shell from the corpus, so it is gated.\n` +
        `  Enable it on THIS machine in ${policyPath()}:\n\n` +
        `    { "${cairnHome()}": { "enabled": true, "note": "who decided, and when" } }\n`,
    );
    return;
  }

  const ready = pending.filter(hasCheck);
  const unready = pending.filter((c) => !hasCheck(c));

  for (const c of ready) {
    const result = await gate(asFinding(c.data));
    const outcome = routeVerdict(result.verdict);
    settle(dir, c, outcome, result.detail);
    console.log(`  [${outcome.padEnd(8)}] ${String(c.data.tool ?? '?')} — ${result.verdict}: ${result.detail}`);
  }

  if (unready.length) {
    console.log(
      `\n  ${unready.length} candidate(s) have no check yet — that is the triage agent's step:\n` +
        '  a session on a live machine writes a discriminating check (command + absentWhen),\n' +
        '  then this pass runs the delta and settles it.',
    );
  }
  reportYield(dir);

  /* Behind the scenes: sign any of this machine's own findings and commit them
   * locally, so admitted findings land in the corpus signed with nobody running
   * sign or commit. Idempotent and safe when there is nothing to do. */
  const sealed = sealAndCommit('cairn: triage admitted findings');
  if (sealed.signed || sealed.committed) {
    console.log(`  sealed: signed ${sealed.signed} as "${sealed.identity}"${sealed.committed ? ', committed' : ''}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(`cairn:triage: ${(e as Error).message}`);
  process.exit(1);
});
