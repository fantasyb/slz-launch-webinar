/**
 * Survivorship: when a duplicate is absorbed, which values survive?
 *
 * `cairn:admit` decides that a submission is a duplicate and proposes keeping
 * the submitter's observation. That is the crudest possible rule -- existing
 * record wins everything -- and at scale it discards real improvements. The
 * fifty-first person to hit the sandbox proxy may well have written a clearer
 * title, a better workaround, or captured output the original never had.
 *
 * Master data management names this problem and solves it per FIELD rather
 * than per record: most recent, most complete, most trusted source, union.
 * The rules below are that, made specific to what a finding is.
 *
 * THREE KINDS OF FIELD, AND THE KIND DECIDES THE RULE
 *
 * UNION -- evidence, observations, tags. Never choose; keep both. These are
 * accumulated attestation, and discarding half of it is the one thing this
 * corpus must never do: `confidence` rises with confirmation and
 * `scope: universal` has to be earned across environments, so throwing away
 * an observation actively weakens a claim that just got stronger.
 *
 * SAFER -- halfLifeDays, scope. When two records disagree about how fast a
 * claim goes stale or how widely it holds, take the more conservative value.
 * A claim that decays faster is re-checked sooner; a narrower scope makes a
 * smaller promise. Both fail toward asking again rather than toward asserting.
 *
 * JUDGED -- title, claim, workaround, mechanism. Which of two prose fields is
 * better is not a length comparison, and pretending otherwise is how "most
 * complete" quietly becomes "most verbose". These are surfaced as a CHOICE for
 * a person, with both values shown, and never resolved automatically.
 *
 * Nothing here mutates. It produces a proposal.
 */
import type { Finding } from './schema';
import { confidence } from './decay';

export type Rule = 'union' | 'safer' | 'judged' | 'keep';

export interface Decision {
  field: string;
  rule: Rule;
  /** What the merged record would hold, for union and safer. */
  value?: unknown;
  /** For judged fields: both candidates, for a person to pick between. */
  existing?: string;
  incoming?: string;
  why: string;
}

const len = (s?: string) => (s ?? '').trim().length;

/**
 * Confidence below which a finding counts as stale for survivorship.
 *
 * Not a fresh/stale boundary invented here -- it is the point at which this
 * corpus already stops treating a claim as reliable, and reusing it means one
 * notion of "no longer sure" rather than two that can drift apart.
 */
const DECAYED = 0.5;

/**
 * What would survive if `incoming` were absorbed into `existing`.
 *
 * Ordered so the union rules come first: they are the ones that must not be
 * lost, and a reader who stops reading has seen them.
 */
export function proposeSurvivor(existing: Finding, incoming: Finding): Decision[] {
  const out: Decision[] = [];

  // --- UNION: attestation is never discarded ---
  const obs = [...(existing.observations ?? []), ...(incoming.observations ?? [])];
  out.push({
    field: 'observations',
    rule: 'union',
    value: obs.length,
    why:
      `${existing.observations?.length ?? 0} + ${incoming.observations?.length ?? 0} = ${obs.length}. ` +
      'A duplicate is evidence the finding is real; confidence and scope both key on it.',
  });

  const envs = new Set(
    obs.filter((o) => o.environment).map((o) => `${o.environment!.os}/${o.environment!.arch}`),
  );
  if (envs.size > 1) {
    out.push({
      field: 'scope',
      rule: 'safer',
      value: existing.scope,
      why:
        `merged observations span ${envs.size} environments (${[...envs].join(', ')}) — ` +
        'enough to earn a wider scope, which the linter checks and a person should decide.',
    });
  }

  const evidence = [...(existing.evidence ?? []), ...(incoming.evidence ?? [])];
  if ((incoming.evidence ?? []).length) {
    out.push({
      field: 'evidence',
      rule: 'union',
      value: evidence.length,
      why: `${(incoming.evidence ?? []).length} captured output(s) the existing record does not have.`,
    });
  }

  for (const field of ['tags', 'triggers'] as const) {
    const a = (existing[field] ?? []) as string[];
    const b = (incoming[field] ?? []) as string[];
    const extra = b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (extra.length) {
      out.push({
        field, rule: 'union', value: [...a, ...extra],
        why: `adds ${extra.map((x) => `"${x}"`).join(', ')} — more ways to reach the same finding.`,
      });
    }
  }

  // --- SAFER: disagreement resolves toward asking again ---
  if (incoming.halfLifeDays !== existing.halfLifeDays) {
    const value = Math.min(existing.halfLifeDays, incoming.halfLifeDays);
    out.push({
      field: 'halfLifeDays', rule: 'safer', value,
      why:
        `${existing.halfLifeDays} vs ${incoming.halfLifeDays}; the shorter half-life is re-checked ` +
        'sooner, so disagreement fails toward verifying rather than toward asserting.',
    });
  }

  /*
   * VOCABULARY: keep how they said it, even when the record does not survive.
   *
   * Measured, and it is the difference between the pipeline helping and
   * hurting. Four hundred write-ups of thirty-seven traps rank at 0.863;
   * collapsing them to thirty-seven records drops that to 0.800, because
   * eleven write-ups are eleven phrasings and a query has eleven chances to
   * match one. Carrying the absorbed titles and symptoms onto the survivor
   * restores 0.863 from thirty-seven records at a fifth of the query cost.
   *
   * One record, every way anyone has described the trap. That is what makes
   * the corpus get STRONGER as it grows rather than merely larger.
   */
  const phrasing = [incoming.title, incoming.reality].filter(Boolean).join(' ').trim();
  if (phrasing && !(existing.mechanism ?? '').includes(incoming.title)) {
    out.push({
      field: 'aliases',
      rule: 'union',
      value: phrasing.slice(0, 200),
      why:
        'how this person described the same trap, kept as searchable text. ' +
        'Discarding it costs real recall: measured 0.863 -> 0.800 when absorbed ' +
        'write-ups lost their wording.',
    });
  }

  /*
   * RECENCY breaks a tie, but only against a claim that has gone stale.
   *
   * Models change, environments change, and a finding recorded eighteen months
   * ago about a tool that has since been rewritten should not outrank a fresh
   * account of the same trap. Decayed confidence is the corpus's own statement
   * that it is no longer sure, so that is the condition -- not age alone,
   * because an old finding that keeps being reconfirmed is not stale, it is
   * established.
   */
  const now = new Date();
  const existingConfidence = confidence(existing, now);
  const incomingSeen = incoming.observations?.[0]?.at;
  const staleExisting = existingConfidence < DECAYED;
  if (staleExisting && incomingSeen) {
    out.push({
      field: '__supersede',
      rule: 'safer',
      value: incoming.id,
      why:
        `${existing.id} has decayed to ${(existingConfidence * 100).toFixed(0)}% confidence and ` +
        `the submission was seen ${incomingSeen.slice(0, 10)}. Prefer the newer account for the ` +
        'judged fields below: the corpus itself says it is no longer sure of the old one.',
    });
  }

  // --- JUDGED: surfaced, never decided ---
  for (const field of ['title', 'claim', 'workaround', 'mechanism'] as const) {
    const a = existing[field] as string | undefined;
    const b = incoming[field] as string | undefined;
    if (!len(b)) continue;
    if ((a ?? '').trim() === (b ?? '').trim()) continue;
    if (!len(a)) {
      out.push({
        field, rule: 'union', value: b,
        why: 'the existing record has nothing here; the submission does.',
      });
      continue;
    }
    out.push({
      field, rule: 'judged', existing: a, incoming: b,
      why:
        'which prose is clearer is not a length comparison, and "most complete" ' +
        'becomes "most verbose" if it is decided mechanically. A person picks.',
    });
  }

  return out;
}
