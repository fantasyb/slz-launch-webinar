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
import { verifyAudit, anchorHead, readAnchors, rotateAudit, readOrgPolicy } from '../src/lib/cairn/enterprise';

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
/* The last anchor this daemon process wrote — kept in memory so a file-write
 * attacker who deletes anchors.jsonl cannot make us silently re-anchor a
 * rewritten log. Reset only on restart, which is an observable event. */
let lastDaemonAnchor: { seq: number; anchorHash: string } | null = null;
/* The set of declared-offload bridges this daemon has ACKNOWLEDGED. Seeded from
 * the first tick (the on-disk state at boot is trusted; the operator's off-box
 * verify is the authority for it). A bridge that appears LATER — a box-write
 * attacker fabricating an "offloaded" segment over a genuine shipped anchor to
 * delete history (audit gap 1) — is novel, and the daemon refuses to anchor over
 * it (which would launder the forged head off-box) until an operator acknowledges. */
let ackBridges: Set<string> | null = null;
let bridgeMarkerMine = false; // this process raised the bridge-review marker
function maybeVerifyAudit(): void {
  if (auditVerifyMs === 0 || stopping || !home) return;
  if (lastAuditVerify && Date.now() - lastAuditVerify < auditVerifyMs) return;
  lastAuditVerify = Date.now();
  const dir = path.join(home, 'audit');
  const marker = path.join(dir, 'ALARM.json');
  let v;
  try {
    // Do NOT short-circuit on a missing audit.jsonl: after a rotation there are
    // archived segments (and a checkpoint) even when the live file was just
    // deleted, and a DELETION of the live log is exactly what verify must catch.
    // verify returns ok on a genuinely-fresh dir (no segments, no checkpoints).
    if (!fs.existsSync(path.join(dir, 'audit.jsonl')) && !fs.existsSync(path.join(dir, 'audit.segments.jsonl')) && !fs.existsSync(path.join(dir, 'head.json'))) return;
    // On-box liveness monitor: it holds no off-box anchors, so it bridges DECLARED
    // offloads (offloadArchive marked them, boundary shipped off-box) instead of
    // false-alarming on every legitimate offload (Fable-6 #2). Undeclared absence
    // is still a hard ALARM; the offloaded ranges are vouched for by the operator's
    // authoritative `verify --against <off-box anchors>`, which does not trust the flag.
    v = verifyAudit(dir, { trustDeclaredOffload: true });
  } catch (e) {
    // A THROW out of verify is itself an alarm, never an "ignore": verify is
    // written to return a broken-chain verdict for every tamper it knows, so a
    // throw means the log reached a state its own checker could not evaluate —
    // which an attacker could try to induce to mute detection. Raise the alarm
    // marker rather than swallowing it.
    process.stderr.write(`cairn:daemon AUDIT ALARM — verify threw (treated as tampering): ${(e as Error).message}\n`);
    try { fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), detail: `audit verify threw: ${(e as Error).message}` }, null, 2) + '\n'); } catch { /* best-effort */ }
    return;
  }
  if (v.ok) {
    // Intact: clear any stale alarm from a prior break that has since been fixed.
    try { if (fs.existsSync(marker)) fs.unlinkSync(marker); } catch { /* best-effort */ }
    // Make declared-offload bridging visible: the daemon trusts the flag for
    // on-box liveness, so surface which ranges were bridged rather than re-hashed,
    // so an operator can reconcile them against the off-box anchors they hold.
    if (v.bridged?.length) process.stderr.write(`cairn:daemon audit ${v.detail}\n`);
    // NOVEL-BRIDGE guard (audit gap 1). A declared-offload bridge that appears
    // after boot may be a fabricated "offloaded" segment planted over a genuine
    // shipped anchor to delete history — which the on-box check cannot tell from a
    // real offload. Refuse to anchor/rotate over it (never launder a forged head
    // off-box) until an operator, having checked their off-box anchors, removes the
    // review marker. A legitimate CLI offload trips this exactly once.
    const bridgeMarker = path.join(dir, 'BRIDGE-REVIEW.json');
    const curBridges = new Set((v.bridged ?? []).map((b) => b.file));
    if (ackBridges === null) {
      ackBridges = curBridges; // first tick trusts the on-disk state
    } else {
      const novel = [...curBridges].filter((f) => !ackBridges!.has(f));
      if (novel.length) {
        if (bridgeMarkerMine && !fs.existsSync(bridgeMarker)) {
          ackBridges = curBridges; bridgeMarkerMine = false; // operator acknowledged
        } else {
          if (!bridgeMarkerMine) {
            try { fs.writeFileSync(bridgeMarker, JSON.stringify({ at: new Date().toISOString(), novelOffloadedArchives: novel, detail: 'a declared-offload bridge appeared that this daemon did not observe at startup. Verify it was a legitimate offload against your OFF-BOX anchors, then remove this file to acknowledge. Anchoring and rotation are paused until then.' }, null, 2) + '\n'); } catch { /* best-effort */ }
            bridgeMarkerMine = true;
          }
          process.stderr.write(`cairn:daemon AUDIT ALARM — a new off-loaded archive appeared (${novel.join(', ')}); refusing to anchor until acknowledged (remove ${bridgeMarker}).\n`);
          return; // do NOT anchor or rotate this tick
        }
      }
    }
    // H4 defense: the daemon remembers, IN PROCESS, the last anchor it wrote —
    // memory an attacker with file-write access cannot erase. If the on-disk
    // anchor log no longer ends with that anchor (deleted or replaced), someone
    // tampered with it: alarm and REFUSE to re-anchor, so we never launder a
    // rewritten log into a fresh genesis-rooted anchor chain and ship it off-box.
    if (lastDaemonAnchor) {
      const disk = readAnchors(dir);
      const tip = disk.length ? disk[disk.length - 1] : null;
      if (!tip || tip.anchorHash !== lastDaemonAnchor.anchorHash) {
        process.stderr.write('cairn:daemon AUDIT ALARM — the anchor log was deleted or replaced since I last wrote it; refusing to re-anchor (possible tampering).\n');
        try { fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), detail: 'anchor log deleted/replaced since last daemon anchor', expectedAnchorHash: lastDaemonAnchor.anchorHash }, null, 2) + '\n'); } catch { /* best-effort */ }
        return;
      }
    }
    // Checkpoint the verified head as an anchor and ship it off-box (if
    // CAIRN_AUDIT_ANCHOR_CMD is set). Only anchors a head that verified clean.
    try {
      const a = anchorHead(dir);
      if (a) { lastDaemonAnchor = { seq: a.seq, anchorHash: a.anchorHash }; process.stderr.write(`cairn:daemon audit anchored at seq ${a.seq}\n`); }
    } catch (e) { process.stderr.write(`cairn:daemon audit anchor failed (ignored): ${(e as Error).message}\n`); }
    // Auto-rotate when the live segment grows past the threshold, so appends and
    // the tail read stay cheap however long the gateway runs. The chain continues
    // across the boundary (anchors stay valid); the archive is left for offload.
    // Disable with CAIRN_AUDIT_ROTATE_BYTES=0.
    const rotateBytes = (() => { const n = Number(process.env.CAIRN_AUDIT_ROTATE_BYTES); return Number.isFinite(n) ? n : 100 * 1024 * 1024; })();
    if (rotateBytes > 0) {
      try {
        const size = fs.existsSync(path.join(dir, 'audit.jsonl')) ? fs.statSync(path.join(dir, 'audit.jsonl')).size : 0;
        if (size > rotateBytes) {
          const rot = rotateAudit(dir);
          if (rot.ok) {
            // Rotation took a final boundary anchor; keep our in-memory H4 pointer
            // aligned with the on-disk anchor tip so the deletion check stays sound.
            const tip = readAnchors(dir).slice(-1)[0];
            if (tip) lastDaemonAnchor = { seq: tip.seq, anchorHash: tip.anchorHash };
            process.stderr.write(`cairn:daemon rotated audit log: archived seq ${rot.fromSeq}-${rot.toSeq} to ${rot.archived}\n`);
          }
        }
      } catch (e) { process.stderr.write(`cairn:daemon audit rotate failed (ignored): ${(e as Error).message}\n`); }
    }
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
    // Under an org policy, a signed target is MANDATORY regardless of the env
    // default: this box auto-updates unattended and re-runs the installer (which
    // rewrites the operator's MCP config), so whoever can push to the tracked
    // branch would otherwise get persistent code execution as the operator on a
    // governed deployment. A governed gateway never fast-forwards to an
    // unverified commit even if CAIRN_UPDATE_REQUIRE_SIGNED was left unset.
    // Require a signed update unless the policy is genuinely ABSENT (status
    // 'none'). A read ERROR (a torn or permission-broken policy) must fail CLOSED —
    // treating it as ungoverned would silently drop the signing requirement and
    // fast-forward an unsigned commit exactly when the policy cannot be read
    // (red-team self-update 2.1). The rest of the gateway already fails closed on
    // 'error'; the daemon must too.
    const requireSigned = (() => { try { return readOrgPolicy().status !== 'none'; } catch { return true; } })();
    r = selfUpdate(requireSigned ? { requireSigned: true } : {});
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
