/**
 * cairn:triage-trigger — spawn a triage agent WHEN IT CAN, never blocking.
 *
 * This is the last wire of the automatic pipeline. Sleep harvests candidates for
 * free at every session end; this fires a triage agent to admit or reject them —
 * but only when the conditions to do it honestly are met, and always in the
 * background so the session that triggered it never waits.
 *
 * IT RUNS WHEN, AND ONLY WHEN, IT CAN:
 *   - execution is enabled for this corpus (triage runs checks — shell from the
 *     corpus — so this is gated by policy.ts, off by default), AND
 *   - there are candidates pending, AND
 *   - a triage agent is not already running (a stale-after-30-min lock, so a
 *     crashed run cannot wedge the queue forever).
 * If any is false it exits 0 having done nothing. No candidate is touched, so the
 * next opportunity simply tries again — the queue is eventually-drained, never
 * forced.
 *
 * IT NEVER BLOCKS: the agent is spawned detached and unref'd, and this process
 * exits immediately. Wired at SessionStart, the session opens at once and triage
 * runs beside it on the same live machine — which is the whole point, because that
 * machine is where the trap is live and the check can be honestly run.
 *
 * THE SPAWN IS PLUGGABLE. The default runs a headless `claude -p` over the brief;
 * a machine that drives a different agent sets CAIRN_TRIAGE_CMD. Either way the
 * brief (triageBrief.ts) and the corpus home reach the agent by file and env, so
 * the contract does not depend on which agent runs it. Never throws; always 0.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { homePath, cairnHome } from '../src/lib/cairn/home';
import { executionPolicy } from '../src/lib/cairn/policy';
import { pendingCandidates } from '../src/lib/cairn/triage';
import { triageBrief } from '../src/lib/cairn/triageBrief';
import { machineIdentity } from '../src/lib/cairn/autoseal';

const argv = process.argv.slice(2);
const LOCK = '.triage.lock';
const BRIEF = '.triage-brief.md';
const LOG = '.triage.log';
const STALE_MS = 30 * 60 * 1000;

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

/** Take the lock unless a fresh one is held. Stale locks (a crashed run) are reclaimed. */
function takeLock(dir: string): boolean {
  const lock = path.join(dir, LOCK);
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < STALE_MS) return false; // someone is running
  } catch {
    /* no lock — ours to take */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  try {
    const dir = draftsDir();
    if (!dir) return;
    if (!executionPolicy().enabled) return; // may not run checks here — nothing to do
    const pending = pendingCandidates(dir);
    if (!pending.length) return; // nothing to triage
    if (!takeLock(dir)) return; // a triage agent is already running

    const briefPath = path.join(dir, BRIEF);
    fs.writeFileSync(briefPath, triageBrief(cairnHome(), pending, machineIdentity()?.label));

    /* The spawn is pluggable and detached. Default: a headless agent over the
     * brief. The brief file and CAIRN_HOME are the contract; the command is not. */
    const cmd =
      process.env.CAIRN_TRIAGE_CMD ||
      `claude -p "$(cat "$CAIRN_TRIAGE_BRIEF")" >> "${path.join(dir, LOG)}" 2>&1`;

    const child = spawn('/bin/sh', ['-c', cmd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CAIRN_HOME: cairnHome(), CAIRN_TRIAGE_BRIEF: briefPath },
    });
    child.unref();
    /* A quiet breadcrumb to stderr (hook logs), never to the session's context. */
    process.stderr.write(`cairn:triage-trigger spawned a triage agent for ${pending.length} candidate(s)\n`);
  } catch {
    /* the trigger must never be the reason a session fails to open */
  }
  process.exit(0);
}

main();
