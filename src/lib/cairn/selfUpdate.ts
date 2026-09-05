/**
 * Safe self-update of the Cairn CODE checkout — the one path both the daemon's
 * auto-update tick and `cairn:update` (hence `/cairn update`) call, so "keep it
 * current" means exactly one set of rules wherever it is triggered.
 *
 * This updates the checkout the daemon and gateway run FROM. It is deliberately
 * timid, because it runs unattended against a process that wraps the operator's
 * live tools:
 *
 *   - Fast-forward only. A checkout that has diverged from the pin is never
 *     rewritten; the operator's commits are never discarded, never force-reset.
 *   - Clean tree only. Local uncommitted changes stop the update — we never
 *     stash or throw away work to make room for a pull.
 *   - Pinned remote. It fetches one remote (default origin) and one branch; it
 *     does not chase whatever a config points at today.
 *   - Build-gated with rollback. If the new code does not build, the checkout is
 *     reset to exactly where it was, so a bad upstream commit cannot leave a
 *     half-updated, non-building daemon behind.
 *
 * Pure enough to test: every git call goes through execFileSync against a real
 * repo, and the build step is injectable so a test can drive the decision logic
 * without compiling.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type UpdateStatus =
  | 'updated'
  | 'up-to-date'
  | 'skipped'
  | 'failed'
  | 'rolled-back';

export interface UpdateResult {
  status: UpdateStatus;
  /** HEAD before the update. */
  from?: string;
  /** HEAD after a successful update. */
  to?: string;
  /** How many commits were pulled. */
  advanced?: number;
  /** Why it did nothing / rolled back — the operator-facing reason. */
  reason?: string;
}

export interface UpdateOptions {
  /** The code checkout to update. Defaults to this file's repository root. */
  repoDir?: string;
  /** Remote to fetch from. The pin; default 'origin'. */
  remote?: string;
  /** Branch to fast-forward to. Default: the checkout's current branch. */
  branch?: string;
  /**
   * Run after a fast-forward to prove the new code is sound. Return true to keep
   * the update, false to roll back. Default: `npm run cairn:build-cli`. Pass a
   * no-op returning true to skip (tests), or false to force a rollback path.
   */
  build?: (repoDir: string) => boolean;
  /** Report what would happen without changing the tree. Stops before the
   * fast-forward and returns 'skipped' with a "would fast-forward N" reason. */
  dryRun?: boolean;
}

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Walk up from here to the checkout root (the dir whose package.json is cairn's). */
export function repoRoot(from = __dirname): string {
  let d = from;
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = path.join(d, 'package.json');
      if (fs.existsSync(pkg) && fs.existsSync(path.join(d, '.git'))) return d;
    } catch {
      /* keep walking */
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(from, '..', '..', '..', '..');
}

function defaultBuild(repoDir: string): boolean {
  try {
    execFileSync('npm', ['run', 'cairn:build-cli'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to bring the checkout up to its pin. Never throws — every failure mode is
 * a status the caller can log and carry on from, because an update that cannot
 * happen must never take down the daemon that attempted it.
 */
export function selfUpdate(opts: UpdateOptions = {}): UpdateResult {
  const repoDir = opts.repoDir ?? repoRoot();
  const remote = opts.remote ?? 'origin';
  const build = opts.build ?? defaultBuild;

  // Is this a git checkout at all?
  let from: string;
  try {
    from = git(repoDir, ['rev-parse', 'HEAD']);
  } catch {
    return { status: 'skipped', reason: `not a git checkout: ${repoDir}` };
  }

  // Which branch — the pin's, or the one we are on. A detached HEAD with no
  // branch given has nothing to fast-forward to; say so rather than guess.
  let branch = opts.branch;
  if (!branch) {
    try {
      branch = git(repoDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    } catch {
      /* detached */
    }
    if (!branch) return { status: 'skipped', reason: 'detached HEAD and no branch given' };
  }

  // Clean tree only. We do not stash or discard the operator's work.
  let dirty = '';
  try {
    dirty = git(repoDir, ['status', '--porcelain']);
  } catch {
    return { status: 'skipped', reason: 'could not read working tree status' };
  }
  if (dirty) return { status: 'skipped', reason: 'working tree has local changes' };

  // Fetch the pin. Network failure is a skip, not an error.
  try {
    git(repoDir, ['fetch', '--quiet', remote, branch]);
  } catch (e) {
    return { status: 'skipped', reason: `fetch ${remote} ${branch} failed: ${(e as Error).message.split('\n')[0]}` };
  }

  let target: string;
  try {
    target = git(repoDir, ['rev-parse', 'FETCH_HEAD']);
  } catch {
    return { status: 'skipped', reason: `no ${remote}/${branch} to compare against` };
  }
  if (target === from) return { status: 'up-to-date', from };

  // Fast-forwardable only: HEAD must be an ancestor of the target. If the two
  // have diverged (local commits the pin does not have), we refuse — never a
  // force, never a discard.
  let behind = 0;
  try {
    const counts = git(repoDir, ['rev-list', '--left-right', '--count', `${from}...${target}`]).split(/\s+/);
    const ahead = Number(counts[0] ?? 0);
    behind = Number(counts[1] ?? 0);
    if (ahead > 0) return { status: 'skipped', reason: `checkout has ${ahead} local commit(s) not on ${remote}/${branch}; not fast-forwardable` };
    if (behind === 0) return { status: 'up-to-date', from };
  } catch {
    return { status: 'skipped', reason: 'could not compare HEAD to the pin' };
  }

  // Dry run: everything above is read-only, so report the verdict and stop
  // before the one line that changes the tree.
  if (opts.dryRun) return { status: 'skipped', from, to: target, advanced: behind, reason: `would fast-forward ${behind} commit(s) (dry run)` };

  // Fast-forward.
  try {
    git(repoDir, ['merge', '--ff-only', target]);
  } catch (e) {
    return { status: 'skipped', reason: `fast-forward refused: ${(e as Error).message.split('\n')[0]}` };
  }

  // Prove it builds; roll back to exactly where we were if it does not.
  if (!build(repoDir)) {
    try {
      git(repoDir, ['reset', '--hard', from]);
      return { status: 'rolled-back', from, reason: 'new code did not build; reset to the previous commit' };
    } catch (e) {
      return { status: 'failed', from, to: target, reason: `new code did not build AND rollback failed: ${(e as Error).message.split('\n')[0]}` };
    }
  }

  return { status: 'updated', from, to: target, advanced: behind };
}

/** One-line summary for a log or a chat reply. */
export function describeUpdate(r: UpdateResult): string {
  const short = (s?: string) => (s ? s.slice(0, 10) : '?');
  switch (r.status) {
    case 'updated':
      return `updated ${short(r.from)} -> ${short(r.to)} (+${r.advanced} commit${r.advanced === 1 ? '' : 's'}), rebuilt`;
    case 'up-to-date':
      return `already up to date (${short(r.from)})`;
    case 'rolled-back':
      return `rolled back: ${r.reason}`;
    case 'failed':
      return `FAILED: ${r.reason}`;
    default:
      return `no update: ${r.reason}`;
  }
}
