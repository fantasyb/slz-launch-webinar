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
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

async function main(): Promise<void> {
  process.stderr.write(`cairn:daemon up — triage every ${intervalMs / 1000}s, home ${home ?? '(default)'}\n`);
  while (!stopping) {
    await tick();
    if (stopping) break;
    await interruptibleSleep(intervalMs);
  }
  process.stderr.write('cairn:daemon stopping\n');
  process.exit(0);
}

main();
