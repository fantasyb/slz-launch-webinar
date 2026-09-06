/**
 * cairn:daemon — drain the triage queue on a fixed interval, forever.
 *
 * Session-start triage is bursty and fragile: it only fires when you open a
 * session, only if the hook's environment is right, and it stops the moment you
 * stop working. GBrain's lesson is the opposite — "easier to ship a daemon that
 * runs 24/7 to ingest, enrich and consolidate than to keep an agent in chat
 * working hard." This is that daemon: it runs the same triage trigger every
 * INTERVAL seconds in the background, so the queue drains continuously.
 *
 *   CAIRN_HOME=~/pilot npm run cairn:daemon -- --home ~/pilot --interval 300
 *
 * The trigger it fires is already safe and idempotent: it no-ops unless
 * execution is enabled and candidates clear the cheap gate, it takes a lock so
 * two runs never overlap, and it spawns the agent detached. So ticking it on a
 * timer just means "check often, act when there is honest work." On macOS the
 * installer registers this under launchd (survives logout/reboot); elsewhere,
 * run it under your own service manager or nohup.
 */
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { selfUpdate, describeUpdate, repoRoot } from '../src/lib/cairn/selfUpdate';
import { verifyAudit } from '../src/lib/cairn/enterprise';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
const expand = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const homeRaw = opt('home') ?? process.env.CAIRN_HOME;
const home = homeRaw ? path.resolve(expand(homeRaw)) : undefined;
/*
 * Seconds between ticks. Min 1 so a test can drive it fast; a person uses 300.
 * A non-numeric value (a typo, `CAIRN_DAEMON_INTERVAL=5m`) must fall back to the
 * default, never become NaN — `setInterval(fn, NaN)` fires every millisecond and
 * the wait never completes, so the daemon spins forever on one tick.
 */
function parseInterval(raw: string | undefined): number {
  const n = Number(raw ?? '300');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 300;
}
const intervalMs = parseInterval(opt('interval') ?? process.env.CAIRN_DAEMON_INTERVAL) * 1000;
/** A hung tick must not wedge the loop forever; kill a child that outruns this. */
const TICK_TIMEOUT_MS = 10 * 60_000;

/*
 * Auto-update: keep the code current without the operator re-running the install
 * line. Off means the daemon never touches the checkout. On (the default), every
 * SELF_UPDATE_MS it tries a fast-forward-only, clean-tree-only, build-gated pull
 * (src/lib/cairn/selfUpdate.ts); on a real update it exits so the supervisor
 * (launchd KeepAlive, per the installer) relaunches the new code. Disable with
 * CAIRN_DAEMON_SELF_UPDATE=0, or set CAIRN_SELF_UPDATE_INTERVAL_SEC=0. A typo
 * falls back to the default rather than becoming NaN.
 */
function parseSelfUpdateInterval(): number {
  const raw = process.env.CAIRN_SELF_UPDATE_INTERVAL_SEC;
  if (raw === undefined || raw === '') return 6 * 3600;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 6 * 3600;
  if (n === 0) return 0; // explicit disable
  return Math.max(60, Math.floor(n)); // floor so a small typo cannot hammer git
}
const selfUpdateMs = parseSelfUpdateInterval() * 1000;
const selfUpdateEnabled = selfUpdateMs > 0 && process.env.CAIRN_DAEMON_SELF_UPDATE !== '0';
/* Start the clock at boot, so the first check is one interval away — never at
 * startup, which would let an update->exit->restart cycle re-check immediately. */
let lastSelfUpdate = Date.now();

/*
 * Auto-verify the enterprise audit chain. Writing the log is already automatic
 * (the gateway appends every decision); verifying it must be too, or tampering
 * is caught only when a human remembers to run `cairn:audit-log verify`. The
 * always-on daemon re-walks the chain on a slow tick and raises a LOUD alarm on
 * a break — and drops a marker file so `/cairn` and the CLI surface it even
 * after the log line scrolls. Silent when intact (like self-update up-to-date)
 * and when there is no log (ungoverned). Never throws.
 */
function parseAuditVerifyInterval(): number {
  const raw = process.env.CAIRN_AUDIT_VERIFY_INTERVAL_SEC;
  if (raw === undefined || raw === '') return 3600;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3600;
  if (n === 0) return 0; // explicit disable
  return Math.max(60, Math.floor(n));
}
const auditVerifyMs = parseAuditVerifyInterval() * 1000;
let lastAuditVerify = 0; // verify once shortly after boot, then on the interval
function maybeVerifyAudit(): void {
  if (auditVerifyMs === 0 || stopping || !home) return;
  if (lastAuditVerify && Date.now() - lastAuditVerify < auditVerifyMs) return;
  lastAuditVerify = Date.now();
  const dir = path.join(home, 'audit');
  const marker = path.join(dir, 'ALARM.json');
  let v;
  try {
    if (!fs.existsSync(path.join(dir, 'audit.jsonl'))) return; // ungoverned / no log: nothing to verify
    v = verifyAudit(dir);
  } catch (e) {
    process.stderr.write(`cairn:daemon audit-verify threw (ignored): ${(e as Error).message}\n`);
    return;
  }
  if (v.ok) {
    // Intact: clear any stale alarm from a prior break that has since been fixed.
    try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch { /* best-effort */ }
    return;
  }
  process.stderr.write(
    `cairn:daemon AUDIT ALARM — the tamper-evident log is BROKEN at line ${v.brokenAt}: ${v.detail}. ` +
      'An entry was edited, deleted, or reordered after it was written. Investigate immediately.\n',
  );
  try {
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), brokenAt: v.brokenAt, detail: v.detail, entries: v.entries }, null, 2) + '\n');
  } catch { /* the log line is the primary signal; the marker is a convenience */ }
}

/** Find <repo>/bin/cairn-triage-trigger.js from here, whether run as source (scripts/) or bundle (dist/cli/). */
function findTrigger(): string {
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    const p = path.join(d, 'bin', 'cairn-triage-trigger.js');
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    d = path.dirname(d);
  }
  return path.join(__dirname, '..', 'bin', 'cairn-triage-trigger.js');
}

let stopping = false;
let current: ReturnType<typeof spawn> | null = null;
/* On a stop signal: flag it AND kill any in-flight tick, so SIGTERM exits
 * promptly with a clean 0 instead of leaving main() blocked in `await tick()`
 * until launchd's ExitTimeOut SIGKILLs the process (which reads as a crash). */
const stop = () => { stopping = true; if (current) { try { current.kill('SIGTERM'); } catch { /* already gone */ } } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/**
 * One tick: the trigger by default; CAIRN_DAEMON_TICK_CMD overrides it (tests).
 * Never throws. Two things learned from review: spawn `process.execPath`, not the
 * bare name `node` — under launchd PATH is just /usr/bin:/bin:/usr/sbin:/sbin, so
 * a Homebrew/nvm/pkg `node` is ENOENT and the whole daemon becomes a silent
 * no-op; and inherit stderr so the trigger's breadcrumb and any spawn error land
 * in daemon.log (the one place the installer tells people to look), instead of
 * an empty log next to a healthy-looking daemon.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const override = process.env.CAIRN_DAEMON_TICK_CMD;
      const child = override
        ? spawn('/bin/sh', ['-c', override], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env, timeout: TICK_TIMEOUT_MS, killSignal: 'SIGKILL' })
        : spawn(process.execPath, [findTrigger(), ...(home ? ['--home', home] : [])], {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: { ...process.env, ...(home ? { CAIRN_HOME: home } : {}) },
            timeout: TICK_TIMEOUT_MS,
            killSignal: 'SIGKILL',
          });
      current = child;
      child.on('error', (e) => { process.stderr.write(`cairn:daemon tick failed to spawn: ${(e as Error).message}\n`); current = null; resolve(); });
      child.on('close', () => { current = null; resolve(); });
    } catch (e) {
      process.stderr.write(`cairn:daemon tick threw: ${(e as Error).message}\n`);
      resolve();
    }
  });
}

/** Sleep, but wake early if a stop signal arrives. */
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let waited = 0;
    const step = Math.min(200, ms);
    const t = setInterval(() => {
      waited += step;
      if (stopping || waited >= ms) { clearInterval(t); resolve(); }
    }, step);
  });
}

/*
 * The self-update check, run between triage ticks when due. Synchronous and
 * never throws; on a real update it exits 0 so a supervisor relaunches the new
 * code (run by hand instead of under launchd, restart to pick it up). Everything
 * else — up to date, a clean skip, a rollback — is logged and the loop goes on.
 */
function maybeSelfUpdate(): void {
  if (!selfUpdateEnabled || stopping) return;
  if (Date.now() - lastSelfUpdate < selfUpdateMs) return;
  lastSelfUpdate = Date.now();
  let r;
  try {
    r = selfUpdate();
  } catch (e) {
    process.stderr.write(`cairn:daemon self-update threw (ignored): ${(e as Error).message}\n`);
    return;
  }
  if (r.status === 'up-to-date') return;
  process.stderr.write(`cairn:daemon self-update: ${describeUpdate(r)}\n`);
  if (r.status === 'updated') {
    // Re-run the install after a code update so install-side improvements (new
    // wrapping rules, the security defaults) apply and any MCP server added since
    // the last install gets wrapped — automatically, not only when the operator
    // remembers. Idempotent, and it PRESERVES the trust mode (install reads the
    // existing one), so enforce is never downgraded. Disable with
    // CAIRN_DAEMON_REINSTALL=0.
    if (process.env.CAIRN_DAEMON_REINSTALL !== '0') {
      try {
        execFileSync('npm', ['run', 'cairn:install', '--', ...(home ? ['--home', home] : [])], {
          cwd: repoRoot(),
          stdio: ['ignore', 'inherit', 'inherit'],
          timeout: 5 * 60_000,
        });
        process.stderr.write('cairn:daemon re-ran install after update (new servers wrapped; trust mode preserved)\n');
      } catch (e) {
        process.stderr.write(`cairn:daemon re-install after update failed (ignored): ${(e as Error).message}\n`);
      }
    }
    process.stderr.write('cairn:daemon exiting to reload the new code (a supervisor restarts me; if run by hand, restart to apply).\n');
    process.exit(0);
  }
}

async function main(): Promise<void> {
  process.stderr.write(
    `cairn:daemon up — triage every ${intervalMs / 1000}s, home ${home ?? '(default)'}` +
      `, self-update ${selfUpdateEnabled ? `every ${selfUpdateMs / 1000}s` : 'off'}` +
      `, audit-verify ${auditVerifyMs ? `every ${auditVerifyMs / 1000}s` : 'off'}\n`,
  );
  while (!stopping) {
    await tick();
    if (stopping) break;
    maybeVerifyAudit(); // catch audit tampering without a human running verify
    if (stopping) break;
    maybeSelfUpdate();
    if (stopping) break;
    await interruptibleSleep(intervalMs);
  }
  process.stderr.write('cairn:daemon stopping\n');
  process.exit(0);
}

main();
