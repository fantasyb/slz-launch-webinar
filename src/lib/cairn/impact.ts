/**
 * The impact analyzer — the one number the whole business rests on.
 *
 * Every strategy argument about Cairn eventually bottoms out in a fact we have
 * never measured on real work: when a banked, verified finding is PUSHED onto a
 * live tool result at the moment the trap actually manifests, how much
 * rediscovery does it save — and how often does that happen for the traps that
 * matter (the un-derivable, expensive ones a frontier model would NOT have
 * recovered on its own)?
 *
 * We do not need new counters to answer it. The retrieval ledger already records
 * every push delivery: the gateway calls `served(... 'result')` only when a
 * finding RESONATED — its signature matched the live result — so a ledger row
 * tagged `mcp-proxy:result` is a real moment where the trap was present and the
 * banked knowledge arrived unasked. This joins those events to each finding's
 * own stated rediscovery cost and turns them into a scoreboard.
 *
 * WHAT IT HONESTLY CAN AND CANNOT SAY. It cannot prove the counterfactual — that
 * the agent WOULD have burned the rediscovery cost without the note. Nothing
 * short of a live A/B can. So the time figure is an explicit UPPER BOUND ("if
 * each first delivery prevented a cold rediscovery"), and the decision-grade
 * number is the raw one underneath it: how many times an un-derivable
 * (cost ≥ hours) finding fired on a live result. Each of those is a concrete
 * moment worth inspecting by hand. Counts are truth; the minutes are an estimate
 * wearing its assumptions on the outside.
 */
import type { RetrievalRecord } from './ledger';

/** Rediscovery-cost proxy in minutes. Deliberately round, and printed as an assumption, never hidden. */
export const COST_MINUTES: Record<'minutes' | 'hours' | 'days', number> = {
  minutes: 5,
  hours: 90, // ~1.5h to rediscover a trap that takes "hours"
  days: 480, // one working day
};

/** The minimal shape the analyzer needs from a finding; the CLI supplies it from the corpus. */
export interface FindingLite {
  id: string;
  title: string;
  cost: 'minutes' | 'hours' | 'days';
  tool?: string;
}

export interface FiredFinding {
  id: string;
  title: string;
  tool: string;
  cost: 'minutes' | 'hours' | 'days';
  /** Times this finding was delivered FIRST on a live result (the value-bearing event). */
  firstDeliveries: number;
  /** Times it was re-surfaced as a reminder (same trap, same session — not counted as new value). */
  reminders: number;
  /** Distinct sessions it fired in. */
  sessions: number;
}

export interface ImpactSummary {
  /** The window actually covered by the counted rows. */
  since: string | null;
  until: string | null;
  days: number;

  /** Push deliveries that resonated on a live result — the core signal. */
  pushFirstDeliveries: number;
  pushReminders: number;
  /** First deliveries whose finding is un-derivable-expensive (cost hours or days). The decision number. */
  unDerivableFires: number;
  /** First deliveries whose finding is cheap (cost minutes) — the ones a frontier model likely shrugs off. */
  cheapFires: number;

  /** Distinct findings that fired, distinct tools they fired on, distinct sessions, distinct agents. */
  distinctFindings: number;
  tools: number;
  sessions: number;
  agents: number;

  /** Upper-bound rediscovery-minutes avoided, IF each first delivery prevented a cold rediscovery. */
  estMinutesUpperBound: number;
  /** The same, counting only un-derivable (cost ≥ hours) fires — the conservative, decision-grade figure. */
  estMinutesUnDerivableOnly: number;

  /** Per-finding breakdown, strongest (most un-derivable value) first. */
  fired: FiredFinding[];

  /** Pull retrievals that surfaced a finding (asked-for value), reported separately from push. */
  pullSurfaced: number;
}

const isPushFirst = (r: RetrievalRecord) => r.source === 'mcp-proxy:result';
const isPushReminder = (r: RetrievalRecord) => r.source === 'mcp-proxy:result-reminder';

/**
 * The ASKED-FOR retrievals — a person or agent explicitly searched. Everything
 * else the gateway writes (`mcp-proxy:description`, `:argument`, `:told-surface`,
 * `:call`, …) is an unasked annotation or bookkeeping, NOT a pull, and must not
 * be counted as "asked-for value that surfaced." An allowlist, not "anything
 * that is not a result push" — the latter silently reported every per-tool
 * annotation as a confident pull.
 */
const PULL_SOURCES = new Set(['cli:find', 'cli:brief', 'mcp:find', 'mcp:brief', 'mcp-proxy:find']);

/**
 * The tool the injection actually fired on. The push ledger row writes the query
 * as `<tool> [result]`, which is the real live tool — preferred over the
 * finding's own `trigger`, which only names the tool the finding was authored
 * against. Falls back to the finding's tool, then to 'unknown'.
 */
function toolOf(r: RetrievalRecord, f?: FindingLite): string {
  const m = r.query.match(/^(.*?)\s*\[[a-z-]+\]\s*$/i);
  const fromLedger = (m ? m[1] : '').trim();
  return fromLedger || f?.tool || 'unknown';
}

/**
 * Summarize impact from the raw ledger and a finding lookup. Pure and
 * deterministic. `sinceMs` optionally restricts to a recent window (the
 * two-week test); rows with an unparseable timestamp are kept only when no
 * window is given, so a windowed run never counts undated rows.
 */
export function summarizeImpact(
  records: RetrievalRecord[],
  findingsById: Map<string, FindingLite>,
  opts: { sinceMs?: number } = {},
): ImpactSummary {
  const windowed = opts.sinceMs !== undefined;
  const inWindow = (r: RetrievalRecord): boolean => {
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) return !windowed; // undated rows only survive an unwindowed run
    return !windowed || t >= opts.sinceMs!;
  };
  const rows = records.filter(inWindow);

  const per = new Map<string, FiredFinding & { _sessions: Set<string> }>();
  const toolSet = new Set<string>();
  const sessionSet = new Set<string>();
  const agentSet = new Set<string>();
  let pushFirst = 0;
  let pushReminders = 0;
  let pullSurfaced = 0;

  for (const r of rows) {
    const first = isPushFirst(r);
    const reminder = isPushReminder(r);
    if (first || reminder) {
      for (const ret of r.returned ?? []) {
        const f = findingsById.get(ret.id);
        const tool = toolOf(r, f);
        const cost = f?.cost ?? 'minutes';
        let row = per.get(ret.id);
        if (!row) {
          row = { id: ret.id, title: f?.title ?? '(unknown finding)', tool, cost, firstDeliveries: 0, reminders: 0, sessions: 0, _sessions: new Set() };
          per.set(ret.id, row);
        }
        if (first) { row.firstDeliveries++; pushFirst++; toolSet.add(tool); }
        else { row.reminders++; pushReminders++; }
        if (r.session) { row._sessions.add(r.session); sessionSet.add(r.session); }
        if (r.by) agentSet.add(r.by);
      }
    } else if (PULL_SOURCES.has(r.source ?? '') && (r.returned?.[0]?.strength) === 'strong') {
      /* An asked-for pull (find/brief) that led with a confident finding. */
      pullSurfaced++;
    }
  }

  /*
   * Only findings that actually FIRST-delivered in this window are "fired". A
   * reminder whose first delivery predates the window still creates a per-entry
   * (the reminder path), but reporting it as a ×0 fire would make
   * distinctFindings mean "findings that fired" for some rows and not others.
   * Reminder totals stay in the aggregate counter; they just don't invent a fire.
   */
  const fired: FiredFinding[] = [...per.values()]
    .filter((r) => r.firstDeliveries > 0)
    .map((r) => ({
      id: r.id, title: r.title, tool: r.tool, cost: r.cost,
      firstDeliveries: r.firstDeliveries, reminders: r.reminders, sessions: r._sessions.size,
    }));

  const isUnDerivable = (c: FiredFinding['cost']) => c === 'hours' || c === 'days';
  const unDerivableFires = fired.filter((f) => isUnDerivable(f.cost)).reduce((s, f) => s + f.firstDeliveries, 0);
  const cheapFires = fired.filter((f) => !isUnDerivable(f.cost)).reduce((s, f) => s + f.firstDeliveries, 0);
  const estMinutesUpperBound = fired.reduce((s, f) => s + f.firstDeliveries * COST_MINUTES[f.cost], 0);
  const estMinutesUnDerivableOnly = fired
    .filter((f) => isUnDerivable(f.cost))
    .reduce((s, f) => s + f.firstDeliveries * COST_MINUTES[f.cost], 0);

  /* Rank by un-derivable value first, then raw fire count: the top of the list is what to inspect by hand. */
  fired.sort((a, b) => {
    const av = a.firstDeliveries * COST_MINUTES[a.cost];
    const bv = b.firstDeliveries * COST_MINUTES[b.cost];
    return bv - av || b.firstDeliveries - a.firstDeliveries;
  });

  const times = rows.map((r) => Date.parse(r.at)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const since = times.length ? new Date(times[0]).toISOString() : null;
  const until = times.length ? new Date(times[times.length - 1]).toISOString() : null;
  const days = times.length > 1 ? (times[times.length - 1] - times[0]) / 86_400_000 : 0;

  return {
    since, until, days,
    pushFirstDeliveries: pushFirst,
    pushReminders,
    unDerivableFires,
    cheapFires,
    distinctFindings: fired.length,
    tools: toolSet.size,
    sessions: sessionSet.size,
    agents: agentSet.size,
    estMinutesUpperBound,
    estMinutesUnDerivableOnly,
    fired,
    pullSurfaced,
  };
}

/** Minutes → a short human string (e.g. "7h 20m", "45m"). */
export function humanMinutes(min: number): string {
  if (min <= 0) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
