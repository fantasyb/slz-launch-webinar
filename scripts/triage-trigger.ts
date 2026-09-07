/**
 * cairn:triage-trigger — spawn a triage agent WHEN IT CAN, never blocking.
 *
 * This is the last wire of the automatic pipeline. Sleep harvests candidates for
 * free at every session end; this fires a triage agent to admit or reject them —
 * but only when the conditions to do it honestly are met, and always in the
 * background so the session that triggered it never waits.
 *
 * TWO WAYS TO DRAIN, AND THE MACHINE PICKS THE BEST ONE IT CAN:
 *
 *   - Where execution is OFF (the default), the queue is drained by the
 *     CONSOLIDATION pass (src/lib/cairn/consolidate.ts): an automatic gate that
 *     runs no shell promotes qualifying candidates into cairn/ as unverified,
 *     agent-authored findings and settles the rest with a reason. This trigger
 *     spawns `cairn-sleep --consolidate` detached whenever raw candidates wait,
 *     so a machine that may not run checks still learns — before this, such a
 *     machine's queue only ever grew.
 *   - Where execution is ON, the live gate is strictly better (a discriminating
 *     check, RUN where the trap is live) and owns the queue: a triage agent is
 *     spawned, when candidates clear the cheap gate and no agent already holds
 *     the lock (stale after 30 min, so a crashed run cannot wedge the queue).
 *
 * If nothing applies it exits 0 having done nothing. No candidate is touched, so
 * the next opportunity simply tries again — the queue is eventually-drained,
 * never forced.
 *
 * IT NEVER BLOCKS: both spawns are detached and unref'd, and this process exits
 * immediately. Wired at SessionStart, the session opens at once and the work
 * runs beside it on the same machine — for the live gate, the whole point,
 * because that machine is where the trap is live and the check can be honestly
 * run. The daemon ticks this same trigger, so both paths also run unattended.
 *
 * THE AGENT SPAWN IS PLUGGABLE. The default runs a headless `claude -p` over the
 * brief; a machine that drives a different agent sets CAIRN_TRIAGE_CMD. Either
 * way the brief (triageBrief.ts) and the corpus home reach the agent by file and
 * env, so the contract does not depend on which agent runs it. Never throws;
 * always 0.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { homePath, cairnHome, setCairnHome } from '../src/lib/cairn/home';
import { executionPolicy } from '../src/lib/cairn/policy';
import { pendingCandidates, hasCheck } from '../src/lib/cairn/triage';
import { gateCandidates, DEFAULT_TRIAGE_THRESHOLD } from '../src/lib/cairn/triageScore';
import { triageBrief } from '../src/lib/cairn/triageBrief';
import { machineIdentity } from '../src/lib/cairn/autoseal';

const argv = process.argv.slice(2);
const LOCK = '.triage.lock';
const BRIEF = '.triage-brief.md';
const LOG = '.triage.log';
const CONSOLIDATE_LOG = '.consolidate.log';
const STALE_MS = 30 * 60 * 1000;

/** Find <repo>/bin/cairn-sleep.js from here, whether run as source (scripts/) or bundle (dist/cli/). */
function findSleepBin(): string {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    const p = path.join(d, 'bin', 'cairn-sleep.js');
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    d = path.dirname(d);
  }
  return path.join(__dirname, '..', 'bin', 'cairn-sleep.js');
}

/**
 * Spawn the consolidation pass, detached, with its breadcrumbs in drafts/. The
 * pass takes its own lock and applies its own guards (CAIRN_AUTO_CONSOLIDATE=0,
 * the execution policy), so this only decides whether there is anything for it
 * to look at: a raw sleep candidate — one no triage agent has given a check.
 * `process.execPath`, never a bare `node`: under launchd PATH is bare (daemon.ts).
 */
function spawnConsolidation(dir: string, pending: Array<{ data: Record<string, unknown> }>): boolean {
  if (process.env.CAIRN_AUTO_CONSOLIDATE === '0') return false;
  const raw = pending.filter((c) => c.data._kind === 'sleep-candidate' && !hasCheck({ file: '', data: c.data }));
  if (!raw.length) return false;
  let logFd: number;
  try {
    logFd = fs.openSync(path.join(dir, CONSOLIDATE_LOG), 'a');
  } catch {
    return false;
  }
  try {
    const child = spawn(process.execPath, [findSleepBin(), '--consolidate', '--quiet', '--home', cairnHome()], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CAIRN_HOME: cairnHome() },
    });
    child.on('error', (e) => { try { fs.appendFileSync(path.join(dir, CONSOLIDATE_LOG), `cairn:triage-trigger consolidation spawn failed: ${(e as Error).message}\n`); } catch { /* last resort */ } });
    child.unref();
    return true;
  } catch {
    return false;
  } finally {
    try { fs.closeSync(logFd); } catch { /* already closed */ }
  }
}

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

/**
 * The claude binary, resolved to an absolute path so a hook whose PATH lacks
 * ~/.local/bin (where the CLI often installs) still finds it — the reason the
 * shell-based spawn produced an empty log and never ran. Override with
 * CAIRN_CLAUDE_BIN; otherwise probe the common install locations, then PATH.
 */
function resolveClaudeBin(): string {
  if (process.env.CAIRN_CLAUDE_BIN) return process.env.CAIRN_CLAUDE_BIN;
  const cands = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  try {
    const p = execSync('command -v claude', { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch { /* not resolvable here; fall back to the name so the error surfaces to the log */ }
  return 'claude';
}

/** The corpus this run is for: --home wins, else $CAIRN_HOME. Tilde-expanded, resolved. */
function resolvedHome(): string | null {
  const i = argv.indexOf('--home');
  const raw = i !== -1 && argv[i + 1] ? argv[i + 1] : process.env.CAIRN_HOME;
  if (!raw) return null;
  return path.resolve(raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw);
}

function main(): void {
  try {
    /*
     * Make CAIRN_HOME agree with --home BEFORE any policy or home lookup. The
     * hook is wired as `--home <corpus>` with no CAIRN_HOME, but executionPolicy()
     * and cairnHome() read CAIRN_HOME — so without this the policy for the DEFAULT
     * home was checked, not the corpus we were handed, and on any machine whose
     * corpus is not the default the gate silently read "off" and triage never
     * spawned. --home is authoritative for this run; align the env to it.
     */
    const home = resolvedHome();
    if (home) setCairnHome(home); // resets the memo too, not just the env — see home.ts

    const dir = draftsDir();
    if (!dir) return;
    const pending = pendingCandidates(dir);
    if (!pending.length) return; // nothing to triage
    if (!executionPolicy().enabled) {
      /* This machine may not run checks, so the live gate can never settle the
       * queue here. The consolidation pass can — with no shell — and this is the
       * one place it is fired for a machine like that, on every session start
       * and every daemon tick. */
      if (spawnConsolidation(dir, pending)) process.stderr.write(`cairn:triage-trigger spawned the consolidation pass over ${pending.length} pending candidate(s) (execution is off; no check runs)\n`);
      return;
    }

    /*
     * The cheap gate (score-first cascade). Most of a deep backlog is noise or
     * frontier-recoverable, and spending the expensive check-writer on all of it
     * is the slow, costly path. Score each candidate for free first; only the
     * ones that clear the bar reach the agent. Scores are cached in drafts/ so a
     * re-run or a threshold change re-gates with no recompute; deferred ones are
     * kept, never stamped as failed, and re-gated next time.
     */
    const threshold = Number(process.env.CAIRN_TRIAGE_THRESHOLD) || DEFAULT_TRIAGE_THRESHOLD;
    const { escalate, deferred } = gateCandidates(dir, pending, threshold);
    if (!escalate.length) return; // nothing clears the cheap gate — do not spend the expensive agent
    if (!takeLock(dir)) return; // a triage agent is already running

    /*
     * A bounded bite. Each candidate is a check written and RUN, one after
     * another, so a 60-deep backlog in one brief is a very long, easily-stalled
     * run. Take at most MAX_PER_RUN per fire; the queue drains over successive
     * session starts, which is exactly the cadence the trigger already runs on.
     */
    const MAX_PER_RUN = Number(process.env.CAIRN_TRIAGE_BATCH) || 10;
    const batch = escalate.slice(0, MAX_PER_RUN);
    const briefPath = path.join(dir, BRIEF);
    fs.writeFileSync(briefPath, triageBrief(cairnHome(), batch, machineIdentity()?.label));
    const logPath = path.join(dir, LOG);

    /*
     * The spawn is detached. CAIRN_TRIAGE_CMD is the escape hatch (run through a
     * shell, brief path + CAIRN_HOME in env). The DEFAULT spawns the claude
     * binary directly — an absolute path (so a bare-PATH hook finds it), the
     * brief on stdin (no ARG_MAX limit), output appended to the log, and any
     * spawn failure written to the log rather than vanishing: an empty log used
     * to be the only, silent, symptom of a spawn that never ran.
     */
    /* On a spawn error, DROP THE LOCK so a failed spawn does not wedge the queue
     * for STALE_MS. The 'error' event fires on nextTick, so the process must not
     * exit synchronously before it (see the setImmediate exit below). */
    const onSpawnError = (e: Error, ctx: string) => {
      try { fs.appendFileSync(logPath, `cairn:triage spawn failed${ctx}: ${e.message}\n`); } catch { /* last resort */ }
      try { fs.rmSync(path.join(dir, LOCK)); } catch { /* next start retries */ }
    };
    if (process.env.CAIRN_TRIAGE_CMD) {
      const child = spawn('/bin/sh', ['-c', process.env.CAIRN_TRIAGE_CMD], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CAIRN_HOME: cairnHome(), CAIRN_TRIAGE_BRIEF: briefPath },
      });
      child.on('error', (e) => onSpawnError(e as Error, ''));
      child.unref();
    } else {
      const bin = resolveClaudeBin();
      let logFd: number;
      let briefFd: number;
      try {
        logFd = fs.openSync(logPath, 'a');
        briefFd = fs.openSync(briefPath, 'r');
      } catch {
        return; // could not wire the agent's io; the lock goes stale and the next start retries
      }
      const child = spawn(bin, ['-p'], {
        detached: true,
        stdio: [briefFd, logFd, logFd],
        env: { ...process.env, CAIRN_HOME: cairnHome() },
      });
      child.on('error', (e) => onSpawnError(e as Error, ` for "${bin}"`));
      child.unref();
      /* Close the PARENT's copies of the fds: the detached child has its own, and
       * leaving them open here kept this process alive (defeating the fast exit)
       * and masked the fd as the only handle. */
      try { fs.closeSync(logFd); fs.closeSync(briefFd); } catch { /* already closed */ }
    }
    /* A quiet breadcrumb to stderr (hook logs), never to the session's context. */
    process.stderr.write(
      `cairn:triage-trigger spawned a triage agent for ${batch.length} of ${escalate.length} gated ` +
        `(${pending.length} pending, ${deferred.length} deferred as low-signal)\n`,
    );
  } catch {
    /* the trigger must never be the reason a session fails to open */
  }
  /* setImmediate, not a synchronous exit: a spawn 'error' is emitted on the
   * nextTick queue, and exiting synchronously ran BEFORE it — so a failed spawn
   * logged nothing and left the lock held. This lets the error handler run
   * (for the consolidation spawn too). */
  setImmediate(() => process.exit(0));
}

main();
