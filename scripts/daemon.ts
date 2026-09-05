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
/* Seconds between ticks. Min 1 so a test can drive it fast; a person uses 300. */
const intervalMs = Math.max(1, Number(opt('interval') ?? process.env.CAIRN_DAEMON_INTERVAL ?? '300')) * 1000;

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
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** One tick: the trigger by default; CAIRN_DAEMON_TICK_CMD overrides it (used by tests). Never throws. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const override = process.env.CAIRN_DAEMON_TICK_CMD;
      const child = override
        ? spawn('/bin/sh', ['-c', override], { stdio: 'ignore', env: process.env })
        : spawn('node', [findTrigger(), ...(home ? ['--home', home] : [])], {
            stdio: 'ignore',
            env: { ...process.env, ...(home ? { CAIRN_HOME: home } : {}) },
          });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    } catch {
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
