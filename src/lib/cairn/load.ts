import fs from 'fs';
import path from 'path';
import { FindingSchema, type Finding } from './schema';
import {
  confidence,
  decayUrgency,
  disagreement,
  environmentCount,
  scopeSupport,
  standing,
  type Standing,
} from './decay';
import { retrieve } from './retrieval';
import { homePath } from './home';

/**
 * The corpus is a directory of JSON files in git. That is the whole store.
 *
 * No database, no accounts, no write API. Contribution is a pull request,
 * which means the review, the audit log, the attribution and the rollback
 * are all mechanisms that already exist and that agents already know how to
 * drive. A finding nobody will merge is a finding nobody vouched for.
 */

/* A function, not a const: see the note on cacheDir() in federation.ts. */
export const corpusDir = () => homePath('cairn');

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
  if (!fs.existsSync(corpusDir())) return (cache = []);

  const findings = fs
    // withFileTypes, so a subdirectory or a dangling symlink named `*.json`
    // is skipped rather than throwing a raw EISDIR/ENOENT straight past the
    // CorpusError wrapper -- and a symlink cannot pull content in from outside
    // the corpus directory.
    .readdirSync(corpusDir(), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort()
    .map((file) => {
      let parsed: unknown;
      try {
        // The read is inside the try. It was outside, so the two failure modes
        // above escaped as raw errno rather than as a corpus diagnostic.
        // A BOM is stripped: JSON.parse rejects it, and a zero-byte file gets
        // a diagnostic naming the file rather than "Unexpected end of input".
        const raw = fs.readFileSync(path.join(corpusDir(), file), 'utf8').replace(/^\uFEFF/, '');
        if (raw.trim() === '') throw new Error('file is empty');
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

/**
 * Drop the corpus cache so the next loadCorpus() reads fresh from disk.
 *
 * loadCorpus memoises for the life of the process, which is right for a CLI but
 * wrong for a long-lived host: the MCP server records a finding or attests an
 * observation and then, in the same session, cannot find it (stale cache). Call
 * this after any successful write to the corpus. (Id allocation already reads
 * fresh via recordFinding's own freshLocal, so this is about read-after-write
 * visibility, not id safety.)
 */
export function reloadCorpus(): void {
  cache = null;
}

export function getFinding(id: string): Finding | undefined {
  return loadCorpus().find((f) => f.id === id);
}

/**
 * The findings this deployment may serve over HTTP: `visibility: shared` only.
 *
 * The schema documents visibility as "enforced rather than advised" and defaults
 * it to private "because the failure mode of guessing the other way is
 * publishing somebody's org data". Only /api/federation honoured it; every other
 * read route served the whole corpus, so a contributor who withheld `share` was
 * still published the moment their PR merged. Every public read path must go
 * through this, not loadCorpus().
 */
export function publicCorpus(): Finding[] {
  return loadCorpus().filter((f) => f.visibility === 'shared');
}

/**
 * Sort by a computed key, computing it once per element.
 *
 * confidence() and decayUrgency() both reach scopeSupport ->
 * signedEnvironmentCount -> verifyObservation, which is an ed25519 check per
 * observation. Calling them from inside a comparator ran that O(n log n)
 * times per request over the whole corpus, recomputing an answer that cannot
 * change during the sort.
 */
function sortByKey<T>(items: T[], key: (x: T) => number): T[] {
  return items
    .map((x) => ({ x, k: key(x) }))
    .sort((a, b) => b.k - a.k)
    .map((r) => r.x);
}

/** Findings whose re-verification would be most informative, most urgent first. */
export function staleQueue(limit = 20): Finding[] {
  const active = loadCorpus().filter((f) => f.status === 'active');
  return sortByKey(active, (f) => decayUrgency(f)).slice(0, limit);
}

export function byConfidence(findings = loadCorpus()): Finding[] {
  return sortByKey([...findings], (f) => confidence(f));
}

/**
 * Rank findings against a query.
 *
 * A thin wrapper over `retrieve`, kept because every caller wants findings
 * rather than scored hits. The scoring itself moved to `retrieval.ts` after
 * this function's substring matching was measured: `no space left on device`
 * returned all 31 findings, because `on` is a substring of *connection* and
 * every term counted equally, while `ENOSPC` returned none. Both are the same
 * bug — a term's weight has to come from how much it narrows the corpus, not
 * from whether it appears.
 */
export function search(query: string, findings = loadCorpus()): Finding[] {
  return retrieve(query, findings).map((h) => h.finding);
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
    // The DISPLAY id, matching `detail` below. Reporting the native `f.id` for a
    // federated finding (a raw cairn-0002) made the agent resolve it against the
    // LOCAL corpus — a different claim; publicView namespaces it.
    id: publicView(f).id,
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
      environments: environmentCount(f, now),
    },
    detail: `/api/findings/${publicView(f).id}`,
  };
}

/**
 * The id a reader should see, and nothing internal.
 *
 * Two corpora can both hold a cairn-0002 and mean different things, so an
 * upstream finding is presented under its namespaced displayId -- otherwise
 * `detail` links a stranger's claim to whichever local finding happens to
 * share its number. `keys` is stripped for the same reason it exists: it is
 * a verification input carried on the object, not part of the record, and
 * serialize() spreads the whole finding.
 */
function publicView(f: Finding): { id: string; rest: Record<string, unknown> } {
  const { keys: _keys, upstreamName: _n, ...rest } = f as Finding & {
    keys?: unknown;
    upstreamName?: string;
    displayId?: string;
  };
  return { id: (f as { displayId?: string }).displayId ?? f.id, rest: rest as Record<string, unknown> };
}

/** Public shape served by the API. Adds derived scores so agents need no math. */
export function serialize(f: Finding, now: Date = new Date()) {
  const view = publicView(f);
  return {
    ...view.rest,
    id: view.id,
    derived: {
      confidence: Number(confidence(f, now).toFixed(3)),
      standing: standing(f, now),
      // The number the score actually used, not the number of distinct `by`
      // strings. `by` is free text an author chooses, so counting it reported
      // corroboration the scoring never granted: five unsigned confirmations
      // read as five parties here and as zero in `confidence`. Unattributed
      // confirmations are reported separately rather than folded in.
      confirmations: disagreement(f).confirmers,
      unattributedConfirmations: f.observations.filter(
        (o) => o.verdict === 'confirmed' && !o.signature,
      ).length,
      environments: environmentCount(f, now),
      scopeSupport: Number(scopeSupport(f).toFixed(3)),
      urgency: Number(decayUrgency(f, now).toFixed(3)),
    },
  };
}
