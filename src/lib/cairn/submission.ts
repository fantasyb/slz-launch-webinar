import { z } from 'zod';
import { EnvironmentSchema, VerdictSchema } from './schema';
import { loadCorpus } from './load';
import type { Finding } from './schema';

/**
 * Contribution from a foreign project.
 *
 * An agent that hits a trap is working in somebody else's repository. It does
 * not have this repo cloned, it does not have our tooling, and it will not read
 * a long protocol document mid-task. So submission has to be one HTTP call with
 * a shape an agent can produce directly from the failure it just solved.
 *
 * Everything the schema can default, we default. What remains is only what
 * nobody else can supply: what you expected, what happened, and the command
 * that would prove you wrong.
 *
 * The server never holds a write token. It normalises and validates, then hands
 * back a ready-to-push file and the commands to open the pull request, which
 * the agent runs with its OWN credentials. That keeps attribution real — the
 * contribution is signed by whoever actually made it, not by our bot — and
 * means there is no privileged endpoint worth attacking.
 */

// Every bound here mirrors FindingSchema. They must: a submission that passes
// this schema and then fails FindingSchema.parse is a 500 where the caller
// deserved a 400 telling them which field was too long. Unbounded string
// fields were also a free way to make a consumer buffer megabytes before any
// length check ran.
export const MinimalCheckSchema = z.object({
  command: z.string().min(1).max(4000),
  confirmedIf: z.string().min(1).max(2000),
  refutedIf: z.string().min(1).max(2000),
  manual: z.boolean().default(false),
});

export const SubmissionSchema = z.object({
  title: z.string().min(1).max(120),
  claim: z.string().min(40).max(2000),
  expectation: z.string().min(1).max(2000),
  reality: z.string().min(1).max(4000),
  check: MinimalCheckSchema,
  by: z.string().min(1).max(200),

  subject: z
    .object({
      name: z.string().min(1).max(200),
      ecosystem: z.string().min(1).max(100),
      versions: z.string().max(200).default('*'),
    })
    .optional(),
  evidence: z
    .array(
      z.object({
        command: z.string().min(1).max(4000),
        output: z.string().max(20000),
        note: z.string().max(2000).optional(),
      }),
    )
    .max(20)
    .default([]),
  environment: EnvironmentSchema.optional(),
  mechanism: z.string().max(4000).optional(),
  workaround: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(12).default([]),
  kind: z.enum(['trap', 'limitation', 'dead-end', 'correction']).default('trap'),
  cost: z.enum(['minutes', 'hours', 'days']).default('hours'),
  /** Where it holds. Defaults to the honest answer: where you saw it. */
  appliesTo: z.string().max(1000).optional(),
  note: z.string().max(4000).optional(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export const ObservationSubmissionSchema = z.object({
  findingId: z.string().regex(/^cairn-\d{4}$/),
  verdict: VerdictSchema,
  by: z.string().min(1).max(200),
  note: z.string().min(1).max(4000),
  environment: EnvironmentSchema.optional(),
});

export function nextFindingId(): { id: string; num: string } {
  const max = loadCorpus().reduce((m, f) => Math.max(m, parseInt(f.id.slice(6), 10)), 0);
  const num = String(max + 1).padStart(4, '0');
  return { id: `cairn-${num}`, num };
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

/** Expand a minimal submission into a full, schema-valid finding. */
export function normalise(s: Submission, now = new Date()) {
  const { id, num } = nextFindingId();
  const at = now.toISOString();
  return {
    finding: {
      id,
      title: s.title,
      // Default to the honest scope: you saw it fail in one place.
      scope: 'environment-specific' as const,
      appliesTo:
        s.appliesTo ??
        (s.environment
          ? `Observed on ${s.environment.os}${s.environment.arch ? `/${s.environment.arch}` : ''}` +
            `${s.environment.runtime ? ` running ${s.environment.runtime}` : ''}. Breadth beyond this is unestablished.`
          : 'Environment not reported by the submitter.'),
      claim: s.claim,
      kind: s.kind,
      subject: s.subject ?? { name: 'unknown', ecosystem: 'unknown', versions: '*' },
      tags: s.tags,
      cost: s.cost,
      expectation: s.expectation,
      reality: s.reality,
      ...(s.mechanism ? { mechanism: s.mechanism } : {}),
      ...(s.workaround ? { workaround: s.workaround } : {}),
      evidence: s.evidence,
      check: s.check,
      provenance: 'firsthand' as const,
      halfLifeDays: 180,
      observations: [
        {
          at,
          by: s.by,
          verdict: 'confirmed' as const,
          note: s.note ?? 'Submitted via /api/submit from the environment where it was hit.',
          ...(s.environment ? { environment: s.environment } : {}),
        },
      ],
      predictions: [],
      status: 'active' as const,
      createdAt: at,
    },
    path: `cairn/${num}-${slugify(s.title)}.json`,
    branch: `cairn/${num}-${slugify(s.title)}`.slice(0, 60),
  };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'does',
  'not', 'but', 'its', 'are', 'was', 'you', 'your', 'can', 'has', 'have',
]);

function significantTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

/**
 * Duplicate suggestions have to be precise, not generous.
 *
 * A generic full-text search over a submission surfaces anything sharing a
 * common word — "npm" matches half the corpus — and an agent shown three
 * irrelevant candidates learns to ignore the field entirely. So this requires
 * at least two significant terms in common with the candidate's own title or
 * tags, which is a high bar that stays quiet unless there is a real overlap.
 */
export function likelyDuplicates(title: string, findings: Finding[] = loadCorpus()) {
  const mine = significantTerms(title);
  return findings
    .map((f) => {
      const theirs = significantTerms(`${f.title} ${f.tags.join(' ')} ${f.subject.name}`);
      const shared = [...mine].filter((t) => theirs.has(t));
      return { f, shared };
    })
    .filter((r) => r.shared.length >= 2)
    .sort((a, b) => b.shared.length - a.shared.length)
    .slice(0, 3)
    .map((r) => ({ id: r.f.id, title: r.f.title, sharedTerms: r.shared }));
}
