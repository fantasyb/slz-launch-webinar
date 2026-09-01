import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Finding } from './schema';

/**
 * Does this check actually distinguish the trap from its absence?
 *
 * `doctor` reports a finding LIVE when its check exits zero, so the whole
 * report is only information if the check exits DIFFERENTLY when the trap is
 * not there. Measured across the first forty findings, four of nineteen
 * runnable checks did. Every one of those was written by an agent with the
 * schema in front of it, so this is the one measured failure mode of
 * agent-written findings, and it is the one thing here a machine can settle
 * without trusting the author.
 *
 * THE DELTA IS ON THIS MACHINE, NEVER A SECOND ONE.
 *
 * The obvious design -- run it where the trap is live and where it is not --
 * needs a machine without the trap, which mostly does not exist, and it
 * passes the failure it most needs to catch. Eight checks in this corpus grep
 * their way around the Cairn repository; on a second machine they exit
 * differently because the REPOSITORY is absent, not because the trap is, and
 * a two-machine gate reads that as discrimination. Changing one thing on one
 * machine cannot be fooled that way: nothing about the repository moved, so a
 * check that only sees the repository returns the same answer twice and is
 * refused.
 */

export type GateVerdict =
  | 'discriminates'
  | 'same-either-way'
  | 'not-live'
  | 'no-delta'
  | 'error';

export interface GateResult {
  verdict: GateVerdict;
  detail: string;
  /** Exit status with the trap present, and with the delta applied. */
  live: number | null;
  absent: number | null;
  delta?: string;
}

/**
 * How to make the trap not apply, without leaving this machine.
 *
 * `absentWhen` is supplied by whoever wrote the finding and is the honest
 * source: at solve time they have just made the failure go away and know
 * exactly what did it. Failing that, an `env:` precondition negates
 * mechanically -- unsetting a variable is safe, reversible and scoped to one
 * subprocess. `cmd:`, `path:` and `os:` predicates are NOT negated: removing
 * a binary from PATH to satisfy a gate is a side effect on someone's machine,
 * and this refuses to be that.
 */
export function deltaPlan(f: Finding): string | null {
  const explicit = (f.check as { absentWhen?: string }).absentWhen;
  if (explicit && explicit.trim()) return explicit.trim();

  for (const p of f.precondition ?? []) {
    if (p.startsWith('env:')) {
      const name = p.slice(4).split('=')[0];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `unset ${name}`;
    }
  }
  return null;
}

function run(command: string, timeoutMs: number): Promise<number | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-gate-'));
  const script = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.sh`);
  fs.writeFileSync(script, `exec 2>&1\n${command}\n`, { mode: 0o700 });
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      [script],
      { timeout: timeoutMs, maxBuffer: 1 << 20, killSignal: 'SIGKILL' },
      (err) => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* disposable */
        }
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? null
              : 0;
        resolve(code);
      },
    );
  });
}

/**
 * Run the check, then run it again with the trap removed, and compare.
 *
 * Exit 77 is this project's "could not decide" and is never a verdict, so a
 * check that answers 77 either way is reported as an error rather than as
 * discrimination.
 */
export async function gate(f: Finding, timeoutMs = 20_000): Promise<GateResult> {
  if (f.check.manual) {
    return { verdict: 'no-delta', detail: 'check is marked manual — nothing to run', live: null, absent: null };
  }
  const delta = deltaPlan(f);
  if (!delta) {
    return {
      verdict: 'no-delta',
      detail:
        'no way to make the trap absent on this machine: set check.absentWhen to the command ' +
        'that makes it stop happening',
      live: null,
      absent: null,
    };
  }

  const live = await run(f.check.command, timeoutMs);
  if (live === 77 || live === null) {
    return { verdict: 'error', detail: 'the check could not decide even with the trap present', live, absent: null, delta };
  }
  if (live !== 0) {
    return {
      verdict: 'not-live',
      detail: `the trap is not present here (exit ${live}), so discrimination cannot be observed`,
      live,
      absent: null,
      delta,
    };
  }

  const absent = await run(`${delta}\n${f.check.command}`, timeoutMs);
  if (absent === 0) {
    return {
      verdict: 'same-either-way',
      detail:
        `exits 0 with the trap present AND with \`${delta}\` applied — it is reporting that a ` +
        'shell ran, not whether this is happening',
      live,
      absent,
      delta,
    };
  }
  return {
    verdict: 'discriminates',
    detail: `exit 0 with the trap present, exit ${absent} once \`${delta}\` removes it`,
    live,
    absent,
    delta,
  };
}
