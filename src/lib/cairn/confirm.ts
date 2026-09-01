/**
 * Retrieval stage 3: rank by running the check.
 *
 * Every other memory system's best answer is "here is text that resembles your
 * question." This corpus can do something categorically different, because
 * every finding ships the command that decides whether it is true: it can
 * answer "this one is happening on your machine right now."
 *
 * That is not a better similarity score. It is a different kind of claim — the
 * difference between a search result and a diagnosis — and it is available
 * only because the schema demanded a falsifiable check from the beginning.
 * Text retrieval narrows 31 findings to 3; execution decides which of the 3
 * is your actual problem.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS OPT-IN, LOCAL-ONLY, AND NOT WIRED INTO SEARCH
 * ---------------------------------------------------------------------------
 *
 * It runs shell commands that came out of a corpus. Doing that automatically,
 * to text fetched from a host, is precisely cairn-0014 — the finding this
 * project recorded about itself after shipping "point your agent at this URL
 * and follow it."
 *
 * So the constraints are structural, not advisory:
 *
 *   - LOCAL ONLY. Findings must come from the on-disk corpus, which the
 *     operator can read and reviewed when they cloned it. Never a federated
 *     cache, never an API response. `assertLocalCorpus` enforces this by
 *     identity against `loadCorpus()`, so passing a parsed API payload throws
 *     rather than executing.
 *   - NEVER IMPLICIT. No code path reaches this without a caller explicitly
 *     asking. `retrieve()` stays pure.
 *   - `manual` checks are skipped. They are the ones that want a human, a paid
 *     API or a specific host.
 *   - Bounded time, no shell interpolation of the query, output capped.
 *
 * A check is still arbitrary code from whoever wrote the finding. The honest
 * statement of the guarantee: this is exactly as safe as running the test
 * suite of a repository you cloned, and no safer.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Finding } from './schema';
import { loadCorpus } from './load';
import { assertExecutionAllowed } from './policy';
import { matchEnvironment } from './precondition';

export type Fired = 'fires' | 'does-not-fire' | 'inconclusive' | 'skipped';

export interface Confirmation {
  id: string;
  fired: Fired;
  /** Why, in one line — for a skip, the reason it was not run. */
  detail: string;
  exitCode: number | null;
  ms: number;
}

export interface ConfirmOptions {
  /** Per-check wall clock. Checks are meant to be cheap; this catches the ones that are not. */
  timeoutMs?: number;
  /** Hard cap on how many checks run, so a broad query cannot become a build. */
  max?: number;
  /**
   * How many checks may run at once. Default 4.
   *
   * Checks were run one at a time, which made the wall clock the SUM of the
   * timeouts: three sibling checks at the 20s bound was a minute of waiting to
   * answer one question, and the whole point of confirming siblings is that
   * you need all of their answers before any of them means anything.
   *
   * Set to 1 where checks would interfere. The corpus asks for checks that are
   * cheap and hermetic, but "hermetic" is a claim about side effects and two
   * checks that both MEASURE the machine can still disturb each other — one
   * that fills a disk while another reads free space will make both lie. That
   * is rare enough to be the caller's exception rather than the default.
   */
  concurrency?: number;
}

/**
 * Refuse to execute anything that did not come from the operator's own corpus.
 *
 * Compares by object identity against a fresh load, not by id or by shape: a
 * hostile payload can claim any id and reproduce any structure, but it cannot
 * be the same object the local loader produced from the local directory.
 */
export function assertLocalCorpus(findings: Finding[]): void {
  /*
   * Policy first, provenance second. Both refuse, but they refuse different
   * things: this one asks whether this corpus runs checks AT ALL, and the
   * loop below asks whether these particular findings came off local disk.
   * A reviewer disabling execution must not have to trust that every call
   * site remembered to ask.
   */
  assertExecutionAllowed('checks from the corpus');
  const local = new Set(loadCorpus());
  for (const f of findings) {
    if (!local.has(f)) {
      throw new Error(
        `refusing to execute checks for ${f.id}: finding did not come from the ` +
          'local corpus. Checks are only ever run for findings loaded from disk.',
      );
    }
  }
}

/**
 * Run one finding's check and report whether the failure it describes is
 * present here.
 *
 * The command is written to a file and executed rather than passed to `-c`,
 * because heredocs and multi-line scripts are common in checks and did not
 * survive being flattened. `exec 2>&1` is prepended for the same reason it is
 * in the verifier: a check's decisive line is very often on stderr, and losing
 * it silently turned a real reproduction into an inconclusive one.
 */
export async function runCommand(
  id: string,
  command: string,
  timeoutMs: number,
): Promise<Confirmation> {
  return runCheckCommand(id, command, timeoutMs);
}

async function runCheck(f: Finding, timeoutMs: number): Promise<Confirmation> {
  return runCheckCommand(f.id, f.check.command, timeoutMs);
}

/*
 * Exported through `runCommand` so the exit-code-to-verdict mapping can be
 * tested directly.
 *
 * `cairn:doctor` reported 17 of 17 findings live, twice, with zero negatives —
 * and a result set containing no negatives cannot distinguish a healthy corpus
 * from a harness that says yes to everything. That is cairn-0028 exactly: a
 * gate whose input selector returns nothing passes everything. The negative
 * path needs its own test rather than an argument that it must work.
 */
async function runCheckCommand(
  id: string,
  command: string,
  timeoutMs: number,
): Promise<Confirmation> {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-confirm-'));
  const script = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.sh`);
  fs.writeFileSync(script, `exec 2>&1\n${command}\n`, { mode: 0o700 });

  return new Promise<Confirmation>((resolve) => {
    execFile(
      '/bin/sh',
      [script],
      { timeout: timeoutMs, maxBuffer: 1 << 20, killSignal: 'SIGKILL' },
      (err, stdout) => {
        const ms = Date.now() - started;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* the temp dir is disposable; failing to remove it must not fail the check */
        }
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? null
              : 0;
        const timedOut = Boolean(err && (err as { killed?: boolean }).killed);

        // The verdict is the check's own exit status, and the finding's
        // confirmedIf/refutedIf prose says what that status means. This does
        // NOT try to interpret the output — an LLM reading stdout to decide
        // whether a claim held is exactly the unfalsifiable judgment the
        // executable check exists to replace.
        /*
         * Exit 77 means the check could not decide.
         *
         * Without it every non-zero exit read as "did not reproduce", so a
         * check that could not run at all -- a missing build artifact, an
         * absent tool, no network -- was recorded as evidence AGAINST the
         * finding. That is the worst possible direction for the error to go:
         * confirmations are strong and refutations are weak precisely because
         * a failure to reproduce usually means the environment differed, and
         * here the environment differing was being counted as the finding
         * being wrong.
         *
         * 77 rather than a new convention because it is what autotools,
         * automake and GNU test suites already use for "skipped", so a check
         * author who knows the shell already knows this.
         */
        const fired: Fired = timedOut
          ? 'inconclusive'
          : code === 0
            ? 'fires'
            : code === 77 || code === null
              ? 'inconclusive'
              : 'does-not-fire';

        resolve({
          id,
          fired,
          detail: timedOut
            ? `timed out after ${timeoutMs}ms`
            : (stdout || '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(no output)',
          exitCode: code,
          ms,
        });
      },
    );
  });
}

/**
 * Confirm a shortlist, cheapest signal first.
 *
 * Preconditions are evaluated before anything is executed: a finding whose
 * declared environment does not hold here cannot be reproducing here, and
 * skipping it costs nothing where running it costs seconds.
 */
export async function confirmCandidates(
  candidates: Finding[],
  opts: ConfirmOptions = {},
): Promise<Confirmation[]> {
  assertLocalCorpus(candidates);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const max = opts.max ?? 3;

  // Decide what runs before anything runs, so the plan is a pure function of
  // the input and the skip reasons do not depend on scheduling order.
  const plan: Array<{ f: Finding; skip?: string }> = [];
  let admitted = 0;
  for (const f of candidates) {
    if (f.check.manual) plan.push({ f, skip: 'check is marked manual' });
    else if (f.precondition?.length && !matchEnvironment(f.precondition).matches)
      plan.push({ f, skip: 'precondition does not hold here' });
    else if (admitted >= max) plan.push({ f, skip: `beyond --max ${max}` });
    else {
      plan.push({ f });
      admitted += 1;
    }
  }

  const out = new Map<string, Confirmation>();
  for (const { f, skip } of plan) {
    if (skip) out.set(f.id, { id: f.id, fired: 'skipped', detail: skip, exitCode: null, ms: 0 });
  }

  const queue = plan.filter((p) => !p.skip).map((p) => p.f);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      // Each worker pulls the next index rather than taking a fixed slice, so
      // one slow check cannot leave other workers idle behind it.
      for (;;) {
        const i = next++;
        if (i >= queue.length) return;
        const r = await runCheck(queue[i], timeoutMs);
        out.set(r.id, r);
      }
    }),
  );

  // Input order, not completion order: the caller ranked these and the ranking
  // is information.
  return plan.map((p) => out.get(p.f.id)!);
}
