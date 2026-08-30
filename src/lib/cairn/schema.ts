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

/**
 * Whether the claim is asserted to hold everywhere, or only where stated.
 *
 * This is the field that decides whether a large corpus stays usable.
 * Confirming a negative finding takes one failing run and is decisive;
 * refuting one takes a passing run, which proves nothing, because the
 * failure may simply be environmental. Confirmations are therefore strong
 * and refutations structurally weak, and a false 'this is broken' is sticky
 * — nobody re-runs the experiment that would catch it.
 *
 * The defence is that `universal` is not a thing an author may assert. It
 * is earned by confirmation across distinct environments, and scored down
 * until it has been. A claim seen failing in one place is a hypothesis
 * about that place.
 */
export const ScopeSchema = z.enum(['universal', 'environment-specific']);
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * How the claim is established. This is a different axis from scope, and
 * conflating them breaks the scoring.
 *
 * `empirical` — established by observing a system behave. Environment is a
 *   variable, so breadth of environment is evidence, and a claim that holds
 *   everywhere has to earn that by being confirmed in several places.
 *
 * `structural` — follows from how the thing is built. A signature covers an
 *   identifier, so renaming the record breaks it; an instruction naming a URL
 *   authorises whoever controls that URL later. There is no machine on which
 *   these are false, so "confirm it in a second environment" is not a
 *   meaningful request and the breadth discount would penalise it forever.
 *
 * The distinction also matters downstream. When a model forecasts an empirical
 * claim wrongly, it lacked knowledge of the world; when it forecasts a
 * structural one wrongly, it failed to reason from what it already had. Those
 * are different signals and pooling them corrupts both.
 *
 * The bar for `structural` is higher, not lower: it must carry a derivation,
 * and its check must demonstrate the property rather than merely detect
 * instances of it.
 */
export const BasisSchema = z.enum(['empirical', 'structural']);
export type Basis = z.infer<typeof BasisSchema>;

/**
 * Structured so that breadth can be computed. A free-text environment
 * cannot be counted, and counting distinct environments is the only
 * evidence that separates 'broken' from 'broken on my machine'.
 */
export const EnvironmentSchema = z.object({
  os: z.string().min(1),
  arch: z.string().optional(),
  runtime: z.string().optional(),
  note: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Identity used for counting breadth. Deliberately coarse. */
export function environmentSignature(e: Environment): string {
  return [e.os, e.arch ?? 'any', e.runtime ?? 'any'].join('/').toLowerCase();
}

export const VerdictSchema = z.enum(['confirmed', 'refuted', 'inconclusive']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const EvidenceSchema = z.object({
  command: z.string().min(1).max(4000),
  // Bounded like everything else: an unbounded field is a denial-of-service
  // vector against every consumer of the API, and a place to hide bulk text
  // no reviewer will read to the end of.
  output: z.string().max(20000),
  note: z.string().max(2000).optional(),
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
  note: z.string().max(4000).optional(),
  /**
   * Omitted when the observation was not executed anywhere — a secondhand
   * assertion. Such an observation contributes no breadth, which is the
   * intended consequence.
   */
  environment: EnvironmentSchema.optional(),
  /**
   * Ed25519 signature over the canonical payload. Absent means self-reported
   * and attributable to nobody, which is displayed and weighted down rather
   * than rejected: an unsigned observation is still information.
   */
  signature: z
    .object({
      algorithm: z.literal('ed25519'),
      keyId: z.string().regex(/^[0-9a-f]{16}$/),
      value: z.string().min(1),
    })
    .optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * A forecast recorded BEFORE the check is run.
 *
 * This is the artifact the corpus exists to produce. A finding on its own is
 * a fact, and facts can be scraped. A prediction paired with a mechanically
 * adjudicated outcome is a measurement of the gap between what a model
 * believed and what was true — which cannot be scraped, because it requires
 * commitment in advance and an executable arbiter.
 *
 * `blind` records whether the predictor had seen the finding's evidence and
 * prior observations. An unblinded prediction is nearly worthless: the
 * predictor is reading the answer. The tooling blinds by default.
 */
export const CommitmentSchema = z.object({
  algorithm: z.literal('sha256'),
  /** H(version|findingId|by|prior|reasoning|anchor|nonce). See commitment.ts. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Repo HEAD sha when the seal was created. Bounds the interval from below. */
  /** A git sha. Pattern-constrained because this value reaches git tooling. */
  anchor: z.string().regex(/^[0-9a-f]{7,40}$/),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

/**
 * A forecast, sealed before the check runs and revealed after.
 *
 * This is the artifact the corpus exists to produce. A finding on its own is
 * a fact, and facts can be scraped. A prediction that provably preceded its
 * own adjudication cannot be, because it requires commitment in advance and
 * an executable arbiter.
 *
 * On seal, only `commitment` is published: `priorConfirmed`, `reasoning` and
 * `nonce` are absent, held locally in a gitignored file. That commit is
 * pushed before the check is run. On reveal they are filled in and anyone can
 * recompute the hash. A revealed prediction whose hash does not recompute is
 * `broken` and is never scored.
 *
 * `self` marks a prediction by the finding's own author, who necessarily
 * knew the answer. Recorded for the record, excluded from calibration.
 */
export const PredictionSchema = z
  .object({
    /** When the seal was published. */
    at: z.string().datetime(),
    by: z.string().min(1),
    commitment: CommitmentSchema.optional(),

    /** Revealed phase. Absent while sealed. */
    revealedAt: z.string().datetime().optional(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
    priorConfirmed: z.number().min(0).max(1).optional(),
    reasoning: z.string().max(4000).optional(),

    outcome: VerdictSchema.optional(),
    resolvedAt: z.string().datetime().optional(),

    /** True when the predictor authored the finding and knew the answer. */
    self: z.boolean().default(false),
  })
  .refine((p) => !(p.priorConfirmed !== undefined) || p.reasoning !== undefined, {
    message: 'a revealed prediction must include reasoning',
  })
  .refine((p) => !(p.priorConfirmed !== undefined && p.commitment) || !!p.nonce, {
    message: 'a revealed commitment must include the nonce so the hash can be recomputed',
  });
export type Prediction = z.infer<typeof PredictionSchema>;

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
  claim: z.string().min(1).max(2000),
  kind: KindSchema,
  subject: SubjectSchema,
  scope: ScopeSchema,
  basis: BasisSchema.default('empirical'),
  /**
   * Required for structural findings: why the property must hold, argued from
   * the design. A structural claim without one is an assertion wearing a
   * category label.
   */
  derivation: z.string().max(4000).optional(),
  /** Required when scope is environment-specific: where the claim applies. */
  appliesTo: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).max(12).default([]),
  /** What rediscovering this from scratch costs. Drives triage. */
  cost: CostSchema,

  /** What a competent reader would reasonably predict. */
  expectation: z.string().min(1).max(2000),
  /** What actually happens instead. */
  reality: z.string().min(1).max(4000),
  /** Why it behaves that way, when known. */
  mechanism: z.string().max(4000).optional(),
  /** What to do instead. The part that saves the next agent's afternoon. */
  workaround: z.string().max(4000).optional(),

  evidence: z.array(EvidenceSchema).default([]),
  check: CheckSchema,
  provenance: ProvenanceSchema,

  /**
   * Days until confidence halves absent re-confirmation. The author's
   * estimate of how fast this corner of the world moves. A finding about
   * a nightly build might be 20; one about POSIX semantics, 3000.
   */
  /**
   * Bounded deliberately. Unbounded, this field disables the corpus's central
   * honesty property: a submitter naming a half-life of ten million days keeps
   * a finding permanently `fresh` no matter how old its last check, and the
   * decay that is supposed to force re-verification never happens. The ceiling
   * is ten years, which is longer than any claim about software has earned;
   * the floor stops a finding being made to vanish before anyone reads it.
   */
  halfLifeDays: z.number().int().min(7).max(3650),

  observations: z.array(ObservationSchema).min(1),
  /** Forecasts recorded before verification. See PredictionSchema. */
  predictions: z.array(PredictionSchema).default([]),

  status: z.enum(['active', 'retired']).default('active'),
  retiredReason: z.string().optional(),

  createdAt: z.string().datetime(),
});

export type Finding = z.infer<typeof FindingSchema>;
