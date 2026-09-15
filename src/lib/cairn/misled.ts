/**
 * Misled — the one "use" signal that costs the agent nothing to produce.
 *
 * The ledger has had `helped` / `misled` outcomes since it was designed
 * (ledger.ts) and nothing has ever written one: retrievals record `served` and
 * `surfaced`, and what became of the finding afterwards was never observed. So
 * "use" has only ever been a count, and memory.ts — the ranking's reputation
 * signal — reads zeros.
 *
 * The Bash hook already detects the one event that IS an outcome: a
 * fail-then-recover arc (arcs.ts) — a program failed, then the same program
 * worked. If, shortly before that arc, a finding about that program was served
 * to the session, the finding did not prevent the trap it describes. That is
 * `misled`, and it needs nobody to answer anything.
 *
 * THE JOIN IS A HEURISTIC, AND SAYS SO. An arc carries no session id that
 * matches the ledger's (the hook sees Claude Code's session, the gateway
 * writes its own), so the join is by time on this machine: retrievals within
 * WINDOW_HOURS before the arc, whose returned findings trigger on the arc's
 * program. Two sessions on one box in the same hour can cross; that is a
 * false `misled`, which memory.ts already treats as evidence to weigh (floor
 * on observations, cap on movement), never a rule. Better a countable
 * heuristic than an outcome column that stays empty.
 *
 * Idempotent by arc id (carried in the row's `note`), and an arc must be at
 * least MIN_AGE_HOURS old before it is reconciled, so an in-session answer of
 * "my mistake" — a slip the agent made, not the finding's fault — has time to
 * land and exclude it.
 */
import { readLedger, record, type RetrievalRecord } from './ledger';
import { readArcs, type ArcRecord } from './arcs';
import type { Finding } from './schema';

export const MISLED_SOURCE = 'arc:misled';
export const WINDOW_HOURS = 4;
export const MIN_AGE_HOURS = 1;

const firstToken = (s: string): string => s.trim().toLowerCase().split(/\s+/)[0] ?? '';

/** The programs a finding is about, as an arc key's first token compares: its triggers and its subject. */
export function programsOf(f: Finding): Set<string> {
  const out = new Set<string>();
  for (const t of f.triggers ?? []) if (firstToken(t)) out.add(firstToken(t));
  if (firstToken(f.subject.name)) out.add(firstToken(f.subject.name));
  return out;
}

export interface MisledOptions {
  ledger: RetrievalRecord[];
  arcs: ArcRecord[];
  findings: Finding[];
  now?: Date;
  windowHours?: number;
  minAgeHours?: number;
}

/** Pure: the `misled` rows the ledger is missing, given what is on disk. */
export function misledRows(o: MisledOptions): RetrievalRecord[] {
  const now = o.now ?? new Date();
  const windowMs = (o.windowHours ?? WINDOW_HOURS) * 3_600_000;
  const minAgeMs = (o.minAgeHours ?? MIN_AGE_HOURS) * 3_600_000;
  const done = new Set(o.ledger.filter((r) => r.source === MISLED_SOURCE && r.note).map((r) => r.note));
  const slips = new Set(o.arcs.filter((a) => a.choice === 'my-mistake').map((a) => a.arc));
  const byId = new Map(o.findings.map((f) => [f.id, f] as const));
  const out: RetrievalRecord[] = [];
  const seen = new Set<string>();
  for (const arc of o.arcs) {
    if (arc.choice !== 'offered' || seen.has(arc.arc) || done.has(arc.arc) || slips.has(arc.arc)) continue;
    seen.add(arc.arc);
    const t = Date.parse(arc.at);
    if (!Number.isFinite(t) || now.getTime() - t < minAgeMs) continue;
    const program = firstToken(arc.key);
    if (!program) continue;
    const ids = new Set<string>();
    for (const r of o.ledger) {
      if (r.source === MISLED_SOURCE || !Array.isArray(r.returned) || !r.returned.length) continue;
      const rt = Date.parse(r.at);
      if (!Number.isFinite(rt) || rt > t || t - rt > windowMs) continue;
      for (const x of r.returned) {
        const f = byId.get(x.id);
        if (f && programsOf(f).has(program)) ids.add(x.id);
      }
    }
    if (!ids.size) continue;
    out.push({
      at: now.toISOString(),
      by: 'cairn',
      session: 'arc',
      query: `arc ${arc.arc} on ${arc.key}: served, then failed anyway`,
      returned: [],
      source: MISLED_SOURCE,
      outcomes: Object.fromEntries([...ids].map((id) => [id, 'misled' as const])),
      note: arc.arc,
    });
  }
  return out;
}

/** Reconcile arcs against the ledger and write what is missing. Never throws; returns the rows written. */
export function recordMisled(findings: Finding[], now = new Date()): number {
  try {
    const rows = misledRows({ ledger: readLedger(), arcs: readArcs(), findings, now });
    for (const r of rows) record(r);
    return rows.length;
  } catch {
    return 0;
  }
}
