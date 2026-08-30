import fs from 'fs';
import path from 'path';
import { FindingSchema, type Finding } from './schema';
import {
  confidence,
  decayUrgency,
  environmentCount,
  scopeSupport,
  standing,
  type Standing,
} from './decay';

/**
 * The corpus is a directory of JSON files in git. That is the whole store.
 *
 * No database, no accounts, no write API. Contribution is a pull request,
 * which means the review, the audit log, the attribution and the rollback
 * are all mechanisms that already exist and that agents already know how to
 * drive. A finding nobody will merge is a finding nobody vouched for.
 */

export const CORPUS_DIR = path.join(process.cwd(), 'cairn');

export class CorpusError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'CorpusError';
  }
}

let cache: Finding[] | null = null;

export function loadCorpus(): Finding[] {
  if (cache) return cache;
  if (!fs.existsSync(CORPUS_DIR)) return (cache = []);

  const findings = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new CorpusError(file, `invalid JSON — ${(e as Error).message}`);
      }
      const result = FindingSchema.safeParse(parsed);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new CorpusError(file, `${issue.path.join('.')}: ${issue.message}`);
      }
      return result.data;
    });

  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.id)) throw new CorpusError(f.id, 'duplicate id');
    seen.add(f.id);
  }

  return (cache = findings);
}

export function getFinding(id: string): Finding | undefined {
  return loadCorpus().find((f) => f.id === id);
}

/** Findings whose re-verification would be most informative, most urgent first. */
export function staleQueue(limit = 20): Finding[] {
  return [...loadCorpus()]
    .filter((f) => f.status === 'active')
    .sort((a, b) => decayUrgency(b) - decayUrgency(a))
    .slice(0, limit);
}

export function byConfidence(findings = loadCorpus()): Finding[] {
  return [...findings].sort((a, b) => confidence(b) - confidence(a));
}

export function search(query: string, findings = loadCorpus()): Finding[] {
  const q = query.trim().toLowerCase();
  if (!q) return findings;
  const terms = q.split(/\s+/);
  return findings
    .map((f) => {
      const haystack = [
        f.title,
        f.claim,
        f.subject.name,
        f.subject.ecosystem,
        f.expectation,
        f.reality,
        f.workaround ?? '',
        ...f.tags,
      ]
        .join(' ')
        .toLowerCase();
      // Title and subject hits weigh more than body hits.
      const strong = `${f.title} ${f.subject.name} ${f.tags.join(' ')}`.toLowerCase();
      const score = terms.reduce(
        (acc, t) =>
          acc + (strong.includes(t) ? 3 : 0) + (haystack.includes(t) ? 1 : 0),
        0,
      );
      return { f, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || confidence(b.f) - confidence(a.f))
    .map((r) => r.f);
}

export interface CorpusStats {
  total: number;
  byStanding: Record<Standing, number>;
  firsthand: number;
  ecosystems: number;
  daysCovered: number;
}

export function corpusStats(): CorpusStats {
  const all = loadCorpus();
  const byStanding: Record<Standing, number> = {
    fresh: 0, aging: 0, stale: 0, contested: 0, retired: 0,
  };
  for (const f of all) byStanding[standing(f)]++;
  const oldest = all.reduce<number>(
    (min, f) => Math.min(min, new Date(f.createdAt).getTime()),
    Date.now(),
  );
  return {
    total: all.length,
    byStanding,
    firsthand: all.filter((f) => f.provenance === 'firsthand').length,
    ecosystems: new Set(all.map((f) => f.subject.ecosystem)).size,
    daysCovered: Math.round((Date.now() - oldest) / 86_400_000),
  };
}

/**
 * Minimal projection: enough to decide whether a finding is relevant, and
 * nothing an injection can live in.
 *
 * The default search path is where automatic ingestion happens — an agent
 * fires a broad query and reads whatever comes back, for every loosely
 * matching finding at once. Returning full prose there means a single query
 * pulls the free text of a dozen strangers' findings into the agent's context
 * whether or not any of them turn out to be relevant.
 *
 * So the default returns identity and standing only. The agent picks a
 * finding and fetches that one deliberately. This does not make prose safe; it
 * makes the amount of prose absorbed without a decision proportional to the
 * decisions actually made, which is a structural reduction rather than a
 * detection one — it holds regardless of how clever the injection is.
 */
export function summarise(f: Finding, now: Date = new Date()) {
  return {
    id: f.id,
    title: f.title,
    kind: f.kind,
    scope: f.scope,
    basis: f.basis ?? 'empirical',
    subject: f.subject,
    tags: f.tags,
    cost: f.cost,
    status: f.status,
    derived: {
      confidence: Number(confidence(f, now).toFixed(3)),
      standing: standing(f, now),
      environments: environmentCount(f),
    },
    detail: `/api/findings/${f.id}`,
  };
}

/** Public shape served by the API. Adds derived scores so agents need no math. */
export function serialize(f: Finding, now: Date = new Date()) {
  return {
    ...f,
    derived: {
      confidence: Number(confidence(f, now).toFixed(3)),
      standing: standing(f, now),
      confirmations: new Set(
        f.observations.filter((o) => o.verdict === 'confirmed').map((o) => o.by),
      ).size,
      environments: environmentCount(f),
      scopeSupport: Number(scopeSupport(f).toFixed(3)),
      urgency: Number(decayUrgency(f, now).toFixed(3)),
    },
  };
}
