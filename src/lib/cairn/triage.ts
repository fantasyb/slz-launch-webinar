/**
 * Triage — the opportunistic admission pass that turns harvested candidates into
 * findings, run WHEN IT CAN and deferred when it cannot, until the queue drains.
 *
 * Sleep harvests candidates for free, offline, into drafts/. A candidate is not a
 * finding: it has no check, and nothing has confirmed the trap is real. Admission
 * is the expensive half, and it has one hard requirement the harvest does not —
 * it must run the check on a machine where the trap is actually live, because the
 * only honest test is the one-machine delta (gate.ts): run the check (expect it to
 * fire), make the trap absent, run again (expect it not to). A diskless pass can
 * only write checks that look like tests and pass everywhere — the exact failure
 * the gate exists to catch. So admission belongs to an agent on a live box, not a
 * cron job.
 *
 * THIS MODULE IS THE SPINE, NOT THE JUDGE. It does not write the check (that needs
 * reasoning — the triage agent's job) and it does not write to the corpus (that is
 * cairn_record, so the standing/provenance machinery stays correct). What it owns
 * is everything deterministic around the judgment: which candidates are pending,
 * whether this machine may run checks at all, routing the gate's verdict to an
 * outcome, moving settled candidates out of the queue idempotently, and — the part
 * the consulted design insisted on before any volume is grown — a yield ledger, so
 * "of everything harvested, how much ever became a finding" is a measured number
 * and not a hope.
 *
 * The routing is the whole trick to "run when it can": the gate's `not-live`
 * verdict IS "the trap is not on this machine, so it cannot be settled here." That
 * candidate is not rejected and not admitted — it is left pending for a session
 * where the trap is live. The queue is therefore eventually-consistent across
 * sessions and machines: each opportunity settles what it can, defers what it
 * cannot, and loses nothing.
 */
import fs from 'fs';
import path from 'path';
import type { GateVerdict } from './gate';
import { readsAsProse } from './submission';

/**
 * Where a settled candidate ends up, and what the queue means by it.
 *
 *  - admitted   gate-confirmed on a live machine → a real finding.
 *  - rejected   the gate proved the check does not discriminate → not a finding.
 *  - deferred   could not be settled HERE (trap not live, or the check errored) →
 *               stays in the queue for a session that can settle it.
 *  - lead       deferred too many times to keep waiting → kept as an unverified
 *               lead (a manual, low-standing finding the agent can still use and a
 *               later machine can still confirm), never silently dropped.
 *
 * `lead` is what stops the queue being a black hole. Deferral is only safe if it
 * ends: a candidate the world never puts on a live machine must not vanish, and it
 * must not be admitted as fact it never earned either. So after enough deferrals it
 * becomes an honestly-marked lead — the whole point is that findings help the next
 * agent, and a lead helps more than a candidate rotting unseen in drafts/.
 */
export type Outcome = 'admitted' | 'rejected' | 'deferred' | 'lead';

/** The subtree of drafts/ each terminal outcome moves to. `deferred` stays in the queue. */
const SETTLED_DIR: Record<Exclude<Outcome, 'deferred'>, string> = {
  admitted: 'admitted',
  rejected: 'rejected',
  lead: 'leads',
};
/** How many times a candidate may defer before it is kept as a lead instead of waiting forever. */
export const MAX_DEFERS = 3;
const YIELD_LEDGER = '.yield.jsonl';

/**
 * Map a gate verdict to what the queue should do with the candidate.
 *
 *  - discriminates    the check fires with the trap and not without it → a real,
 *                     checkable finding → admit.
 *  - same-either-way  the check exits the same with the trap present and absent →
 *                     it tests that a shell ran, not that the trap is here → reject.
 *                     This is the self-confirming check the gate exists to catch;
 *                     it dies here with no judgment call.
 *  - no-delta         no way to make the trap absent on this machine (a manual
 *                     check, or no absentWhen) → cannot be settled by execution →
 *                     reject as un-gateable rather than admit unverified.
 *  - not-live         the trap is not present here → NOT this machine's to settle →
 *                     defer, for a session where it is live.
 *  - error            the check could not decide → defer and retry.
 */
export function routeVerdict(v: GateVerdict): Outcome {
  switch (v) {
    case 'discriminates':
      return 'admitted';
    case 'same-either-way':
    case 'no-delta':
      return 'rejected';
    case 'not-live':
    case 'error':
      return 'deferred';
  }
}

export interface Candidate {
  /** Absolute path to the candidate JSON in the queue. */
  file: string;
  /** Parsed contents; shape is whatever sleep wrote, plus an optional check. */
  data: Record<string, unknown>;
}

/** Every pending candidate: a *.json at the root of drafts/ (settled ones have moved). */
export function pendingCandidates(draftsDir: string): Candidate[] {
  let names: string[];
  try {
    names = fs.readdirSync(draftsDir);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const n of names) {
    /* Skip Cairn's own bookkeeping (.triage-scores.json, …) and notes: a dotfile
     * is never a candidate, and note-*.json is the second-tier note queue
     * (notes.ts), not a triage candidate — including it put notes in the brief
     * and the pending count. Only a *.json draft the harvest/proxy wrote is. */
    if (n.startsWith('.') || n.startsWith('note-') || !n.endsWith('.json')) continue;
    const file = path.join(draftsDir, n);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    try {
      out.push({ file, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      /* a malformed candidate is not a reason to stop the whole pass */
    }
  }
  return out;
}

/**
 * Is this candidate READY for the gate — does it carry a runnable, gateable check?
 *
 * Not merely "check.command is a string": the gateway's hole/contradiction drafts
 * carry a PROSE placeholder command with an empty absentWhen, waiting for a person
 * (or the triage agent) to fill in a real check. Treating those as ready ran them
 * through the gate, where deltaPlan returned null -> no-delta -> REJECTED, so every
 * proxy draft was auto-rejected before anyone saw it and the yield ledger recorded
 * it as a gate rejection. A candidate is ready only with a RUNNABLE (non-prose)
 * command; a runnable command with no way to make the trap absent still returns
 * no-delta (an honest refusal), but a prose placeholder must never be gated.
 */
export function hasCheck(c: Candidate): boolean {
  const check = c.data.check;
  if (!check || typeof check !== 'object') return false;
  const command = (check as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() !== '' && !readsAsProse(command);
}

/**
 * Record one settled candidate in the yield ledger and, unless it is merely
 * deferred, move it out of the pending queue. Idempotent by the append-only
 * ledger and the move: a candidate already moved is simply not pending next time.
 *
 * A deferral is not free: it increments the candidate's defer count, and once that
 * reaches MAX_DEFERS the candidate is kept as a `lead` instead of deferring again,
 * so the queue always makes forward progress and nothing waits forever. The escalation
 * is recorded in the ledger under both the final `deferred` event and the `lead`
 * outcome, so the measurement stays honest about what was verified versus merely kept.
 */
export function settle(draftsDir: string, c: Candidate, outcome: Outcome, detail: string): void {
  if (outcome === 'deferred') {
    const defers = (typeof c.data._defers === 'number' ? c.data._defers : 0) + 1;
    appendYield(draftsDir, { file: path.basename(c.file), tool: String(c.data.tool ?? ''), outcome, detail });
    if (defers >= MAX_DEFERS) {
      settle(draftsDir, c, 'lead', `deferred ${defers} times without a live machine — kept as an unverified lead`);
      return;
    }
    try {
      c.data._defers = defers;
      fs.writeFileSync(c.file, JSON.stringify(c.data, null, 2) + '\n');
    } catch {
      /* the count is best-effort; worst case a candidate defers a little longer */
    }
    return; // stays pending for a session that can settle it
  }
  // MOVE FIRST, then record. If the rename fails, the candidate stays pending
  // and is gated again next pass — recording the outcome first meant a failed
  // move left an admitted/rejected row in the ledger AND the candidate still
  // pending, so the next pass double-counted it.
  const dir = path.join(draftsDir, SETTLED_DIR[outcome]);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(c.file, path.join(dir, path.basename(c.file)));
  } catch {
    return; // could not settle it here; leave it pending, do not record an outcome
  }
  appendYield(draftsDir, { file: path.basename(c.file), tool: String(c.data.tool ?? ''), outcome, detail });
}

interface YieldRow {
  file: string;
  tool: string;
  outcome: Outcome;
  detail: string;
}
function appendYield(draftsDir: string, row: YieldRow): void {
  try {
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.appendFileSync(path.join(draftsDir, YIELD_LEDGER), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
  } catch {
    /* the ledger is measurement, never correctness; losing a line is not fatal */
  }
}

export interface YieldSummary {
  admitted: number;
  rejected: number;
  deferred: number;
  lead: number;
  /** Candidates that reached a terminal outcome: admitted, rejected, or kept as a lead. */
  settled: number;
  /** admitted / settled, the number the design says to watch before growing volume. */
  admitRate: number | null;
}

/** Read the yield ledger and summarise it. Deferrals are counted as events, not settlements. */
export function yieldSummary(draftsDir: string): YieldSummary {
  const counts: Record<Outcome, number> = { admitted: 0, rejected: 0, deferred: 0, lead: 0 };
  try {
    const raw = fs.readFileSync(path.join(draftsDir, YIELD_LEDGER), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = (JSON.parse(line) as YieldRow).outcome;
        if (o in counts) counts[o]++;
      } catch {
        /* skip a torn line */
      }
    }
  } catch {
    /* no ledger yet */
  }
  const settled = counts.admitted + counts.rejected + counts.lead;
  return { ...counts, settled, admitRate: settled ? counts.admitted / settled : null };
}
