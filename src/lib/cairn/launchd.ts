/**
 * The macOS launchd LaunchAgent for the always-on triage daemon.
 *
 * Session-start triage only fires when you open a session and stops the moment
 * you stop working — GBrain's lesson is the reverse: ship a daemon that runs
 * 24/7. On macOS the honest way to "always on, survives logout and reboot, no
 * terminal to babysit" is a per-user LaunchAgent: launchd owns the process,
 * restarts it if it dies (KeepAlive), and starts it at login (RunAtLoad).
 *
 * This module ONLY builds the plist text and names its paths. The installer
 * writes it and calls `launchctl`; keeping the string generation pure is what
 * lets a test pin the contract (the daemon bin, --home, the interval, the log
 * destinations) without a Mac.
 */
import os from 'os';
import path from 'path';

/** The reverse-DNS label launchd knows this agent by. Also the plist basename. */
export const LAUNCHD_LABEL = 'com.cairn.daemon';

export interface PlistOpts {
  /** Absolute path to the node binary that runs the daemon. */
  nodeBin: string;
  /** Absolute path to bin/cairn-daemon.js. */
  daemonBin: string;
  /** The corpus this daemon drains. */
  home: string;
  /** Seconds between ticks. */
  intervalSeconds: number;
  /** Where the daemon's stdout/stderr are appended. */
  logPath: string;
}

/** `~/Library/LaunchAgents/<label>.plist` — the per-user agent location launchd loads at login. */
export function plistPath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The LaunchAgent plist. RunAtLoad starts it at login; KeepAlive restarts it if
 * it exits; the daemon itself sleeps between ticks, so KeepAlive is a crash net,
 * not a busy-spin. --home and --interval carry the same contract the CLI takes,
 * and CAIRN_HOME is set too so the trigger the daemon spawns resolves the corpus
 * even before it reads --home.
 */
export function plistContent(o: PlistOpts): string {
  const args = [o.nodeBin, o.daemonBin, '--home', o.home, '--interval', String(o.intervalSeconds)];
  const argXml = args.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${esc(LAUNCHD_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argXml,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>CAIRN_HOME</key>',
    `    <string>${esc(o.home)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${esc(o.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${esc(o.logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
