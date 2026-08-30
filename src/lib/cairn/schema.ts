import { z } from 'zod';

/**
 * A Cairn finding is a claim about how some system actually behaves,
 * usually a negative one: a thing that does not work, or does not work
 * the way its documentation implies.
 *
 * Three properties separate a finding from a blog post:
 *
 *   1. It carries its own re-verification recipe (`check`), so any agent
 *      can cheaply re-test it instead of taking it on faith.
 *   2. It declares a half-life, because facts about software rot, and a
 *      claim that cannot express its own staleness will quietly mislead.
 *   3. It records provenance, so a reader can distinguish "I ran this and
 *      watched it fail" from "I believe this to be true."
 */

export const CostSchema = z.enum(['minutes', 'hours', 'days']);
export type Cost = z.infer<typeof CostSchema>;

export const KindSchema = z.enum([
  /** Behaves plausibly, silently does the wrong thing. The expensive kind. */
  'trap',
  /** Cannot be done at all; stop trying. */
  'limitation',
  /** A whole approach that looked right and is not. */
  'dead-end',
  /** The docs, or common belief, say X; the truth is Y. */
  'correction',
]);
export type Kind = z.infer<typeof KindSchema>;

/**
 * firsthand — the author executed the repro and observed the failure.
 * secondhand — the author believes this but did not re-run it here.
 *
 * The distinction is load-bearing. A corpus that blurs it is a rumour mill.
 */
export const ProvenanceSchema = z.enum(['firsthand', 'secondhand']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const VerdictSchema = z.enum(['confirmed', 'refuted', 'inconclusive']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const EvidenceSchema = z.object({
  command: z.string().min(1),
  output: z.string(),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * The re-verification recipe. `command` should be cheap, hermetic, and
 * side-effect free — an agent may run it on a whim to refresh the corpus.
 */
export const CheckSchema = z.object({
  command: z.string().min(1),
  confirmedIf: z.string().min(1),
  refutedIf: z.string().min(1),
  /** Set when the check needs a human, a paid API, or a specific host. */
  manual: z.boolean().default(false),
});
export type Check = z.infer<typeof CheckSchema>;

export const ObservationSchema = z.object({
  at: z.string().datetime(),
  /** Free-form agent or human identifier. No accounts, no auth, no trust score. */
  by: z.string().min(1),
  verdict: VerdictSchema,
  note: z.string().optional(),
  environment: z.string().optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const SubjectSchema = z.object({
  name: z.string().min(1),
  ecosystem: z.string().min(1),
  /** Versions the finding is believed to hold for. "*" if unbounded. */
  versions: z.string().default('*'),
});
export type Subject = z.infer<typeof SubjectSchema>;

export const FindingSchema = z.object({
  id: z.string().regex(/^cairn-\d{4}$/),
  title: z.string().min(1).max(120),
  /** One sentence. What is true. Written to be falsifiable. */
  claim: z.string().min(1),
  kind: KindSchema,
  subject: SubjectSchema,
  tags: z.array(z.string()).default([]),
  /** What rediscovering this from scratch costs. Drives triage. */
  cost: CostSchema,

  /** What a competent reader would reasonably predict. */
  expectation: z.string().min(1),
  /** What actually happens instead. */
  reality: z.string().min(1),
  /** Why it behaves that way, when known. */
  mechanism: z.string().optional(),
  /** What to do instead. The part that saves the next agent's afternoon. */
  workaround: z.string().optional(),

  evidence: z.array(EvidenceSchema).default([]),
  check: CheckSchema,
  provenance: ProvenanceSchema,

  /**
   * Days until confidence halves absent re-confirmation. The author's
   * estimate of how fast this corner of the world moves. A finding about
   * a nightly build might be 20; one about POSIX semantics, 3000.
   */
  halfLifeDays: z.number().int().positive(),

  observations: z.array(ObservationSchema).min(1),

  status: z.enum(['active', 'retired']).default('active'),
  retiredReason: z.string().optional(),

  createdAt: z.string().datetime(),
});

export type Finding = z.infer<typeof FindingSchema>;
