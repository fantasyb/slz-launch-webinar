/**
 * "Does this finding apply to me?" — as data, not as a command.
 *
 * A finding's `check` answers whether the claim is TRUE. Nothing answered
 * whether it is YOURS, which is the question an agent actually has at the
 * moment it queries. The conditions that decide it were sitting in prose:
 * "sandboxed environments whose outbound HTTPS passes through an allowlist
 * proxy", "containers with a fixed per-session writable allowance". Unqueryable.
 * Meanwhile the field that IS structured — os/arch/runtime — is identical for
 * every finding here and discriminates nothing.
 *
 * These are deliberately NOT shell commands.
 *
 * A precondition has to run automatically or it is useless, and a shell string
 * from a stranger that runs without anyone reading it is the standing RCE that
 * cairn-0014 is about. So the predicate language is closed, tiny, and evaluated
 * in-process: it can read environment variables, look for a binary on PATH,
 * test a path, and check the platform. It cannot execute anything.
 */
import fs from 'fs';
import path from 'path';

export type Predicate = string;

/** `env:NAME` `env:NAME=VALUE` `cmd:NAME` `no-cmd:NAME` `path:/x` `os:linux` */
export const PREDICATE_PATTERN = /^(env|cmd|no-cmd|path|os):[A-Za-z0-9_./=-]{1,120}$/;

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      return fs.statSync(path.join(d, bin)).isFile();
    } catch {
      return false;
    }
  });
}

/** Evaluate one predicate against the current environment. */
export function evaluate(p: Predicate): boolean {
  const i = p.indexOf(':');
  const kind = p.slice(0, i);
  const arg = p.slice(i + 1);
  switch (kind) {
    case 'env': {
      const eq = arg.indexOf('=');
      if (eq === -1) return (process.env[arg] ?? '') !== '';
      return process.env[arg.slice(0, eq)] === arg.slice(eq + 1);
    }
    case 'cmd':
      return onPath(arg);
    case 'no-cmd':
      return !onPath(arg);
    case 'path':
      return fs.existsSync(arg);
    case 'os':
      return process.platform === arg;
    default:
      return false;
  }
}

export type MatchResult = {
  /** every predicate held */
  matches: boolean;
  /** per-predicate outcome, so a near-miss is legible rather than a bare false */
  detail: Array<{ predicate: Predicate; held: boolean }>;
};

/**
 * All predicates must hold. A finding that says "an allowlist proxy AND no dig"
 * describes one situation, not two, and partial matches are reported rather
 * than rounded up — an agent that matches 2 of 3 wants to see which one missed.
 */
export function matchEnvironment(predicates: Predicate[] | undefined): MatchResult {
  if (!predicates || predicates.length === 0) return { matches: false, detail: [] };
  const detail = predicates.map((p) => ({ predicate: p, held: evaluate(p) }));
  return { matches: detail.every((d) => d.held), detail };
}
