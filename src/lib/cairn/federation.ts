import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { FindingSchema, ObservationSchema, type Finding, type Observation } from './schema';
import {
  verifyObservation,
  findingBodyHash,
  deriveKeyId,
  validateLabel,
  type KeyRecord,
} from './signing';
import { loadKeys } from './keys';
import { loadCorpus } from './load';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from './safety';
import { homePath } from './home';

/**
 * Federation: read upstream corpora, score them with your own evidence.
 *
 * The naive version of a shared corpus is one big database everyone writes to,
 * which fails on trust and on relevance at the same time — you inherit
 * everyone's poisoning and everyone's environment-specific noise.
 *
 * Instead: upstream findings are pulled read-only, and your local observations
 * attach to them as an overlay. The confidence you see is computed from
 * upstream's evidence PLUS yours. Your confirmation in your environment
 * changes your score immediately, without waiting for upstream to merge a
 * pull request — and if you later contribute it upstream, it changes theirs.
 *
 * That is why signing had to come first. A federated observation arrives from
 * a repository you do not control; without signatures you would be merging
 * unattributable claims from strangers into your own scoring.
 *
 * Trust boundary: choosing to federate with an upstream is a decision to
 * accept its published keys. A malicious upstream can publish keys for
 * invented agents. Federated keys are therefore namespaced by origin, so an
 * upstream can never impersonate one of your local identities, and federated
 * findings are always attributed to their origin in the UI.
 */

export const UpstreamSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  source: z.string().min(1),
  note: z.string().optional(),
});

export const ConfigSchema = z.object({
  origin: z.string().min(1),
  upstreams: z.array(UpstreamSchema).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;
export type Upstream = z.infer<typeof UpstreamSchema>;

/** What a cairn publishes for others to consume. */
export const FederationBundleSchema = z.object({
  // Bounded and shape-checked, because every field here is written by whoever
  // runs the upstream. `origin` in particular is rendered as an identity on
  // the federation page; an unbounded string is both a display problem and a
  // place to hide bulk text no reviewer reads to the end of.
  origin: z.string().min(1).max(200),
  generatedAt: z.string().max(40),
  findings: z.array(FindingSchema).max(5000),
  keys: z
    .array(
      z.object({
        keyId: z.string().regex(/^[0-9a-f]{16}$/),
        label: z.string().max(64),
        publicKey: z.string().max(4000),
        createdAt: z.string().max(40),
      }),
    )
    .max(1000),
});
export type FederationBundle = z.infer<typeof FederationBundleSchema>;

export const CONFIG_FILE = homePath('cairn.config.json');
export const CACHE_DIR = homePath('.cairn-cache');
export const OVERLAY_DIR = homePath('federation');

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) return { origin: 'cairn.local', upstreams: [] }; // no config: still a placeholder, deliberately unsignable
  return ConfigSchema.parse(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
}

/** Namespaced id: an upstream's cairn-0001 is not your cairn-0001. */
export function federatedId(upstream: string, findingId: string): string {
  return `${upstream}:${findingId}`;
}

export interface FederatedFinding {
  /**
   * Keeps its NATIVE upstream id. Namespacing must not touch it: observation
   * signatures are computed over the finding id, so rewriting it to
   * `<upstream>:<id>` silently invalidates every upstream signature. Use
   * `displayId` for anything user-facing.
   */
  finding: Finding;
  displayId: string;
  upstream: string;
  origin: string;
  /** Observations recorded locally against this upstream finding. */
  overlay: Observation[];
  /** Upstream observations whose signatures verify against upstream keys. */
  verifiedUpstream: number;
  unverifiedUpstream: number;
}

function readBundle(name: string): FederationBundle | null {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  const parsed = FederationBundleSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : null;
}

function readOverlay(upstream: string, findingId: string): Observation[] {
  const file = path.join(OVERLAY_DIR, upstream, `${findingId}.json`);
  if (!fs.existsSync(file)) return [];
  const parsed = z
    .array(ObservationSchema)
    .safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : [];
}

/**
 * The key gate every upstream bundle passes, in one place.
 *
 * Two record-level checks, for the reasons keys.ts states: an id must be
 * derived from the material it claims, and a label must render
 * unambiguously. Upstream bundles are the least trusted input in the system,
 * so they get the same gate rather than a weaker one.
 */
function bundleKeys(bundle: FederationBundle): { keys: Map<string, KeyRecord>; rejected: number } {
  const keys = new Map<string, KeyRecord>();
  let rejected = 0;
  for (const k of bundle.keys as KeyRecord[]) {
    if (deriveKeyId(k.publicKey) !== k.keyId) {
      rejected++;
      continue;
    }
    if (validateLabel(k.label)) {
      rejected++;
      continue;
    }
    keys.set(k.keyId, k);
  }
  return { keys, rejected };
}

/**
 * Merge: an upstream finding with local observations appended.
 *
 * The merged finding keeps upstream's claim, check and half-life — those are
 * upstream's to maintain — and gains your observations, so every derived
 * score reflects your environment as well as theirs.
 */
export function loadFederated(): FederatedFinding[] {
  const config = loadConfig();
  const localKeys = loadKeys();
  const out: FederatedFinding[] = [];

  for (const up of config.upstreams) {
    const bundle = readBundle(up.name);
    if (!bundle) continue;

    // Upstream keys, in their own map so they cannot collide with local
    // identities — a hostile upstream must not be able to publish a key under
    // one of your agents' labels and have its observations read as yours.
    //
    // The two record-level checks that keys/ enforces apply here too: an id
    // must be derived from the key material it claims (or a record could
    // assert an id it never earned), and a label must render unambiguously
    // (or it can impersonate another by appearance alone). Upstream bundles
    // are the least trusted input in the system, so they get the same gate
    // rather than a weaker one.
    const { keys: upstreamKeys, rejected: rejectedKeys } = bundleKeys(bundle);

    for (const finding of bundle.findings) {
      const overlay = readOverlay(up.name, finding.id);
      let verified = 0;
      let unverified = 0;
      for (const o of finding.observations) {
        if (verifyObservation(finding.id, o, upstreamKeys, findingBodyHash(finding)) === 'signed') verified++;
        else unverified++;
      }

      out.push({
        finding: {
          ...finding,
          observations: [...finding.observations, ...overlay],
        },
        displayId: federatedId(up.name, finding.id),
        upstream: up.name,
        origin: bundle.origin,
        overlay,
        verifiedUpstream: verified,
        unverifiedUpstream: unverified,
      });
    }

    if (rejectedKeys > 0) {
      // Not fatal: the observations they would have signed simply fail to
      // verify and are counted as unverified, which is already surfaced.
      console.warn(`federation: ${up.name} published ${rejectedKeys} unusable key record(s)`);
    }

    // The overlay is signed by local keys, which verifyOverlay covers.
    void localKeys;
  }

  return out;
}

export function federationSummary() {
  const federated = loadFederated();
  return {
    upstreams: loadConfig().upstreams.length,
    findings: federated.length,
    withLocalEvidence: federated.filter((f) => f.overlay.length > 0).length,
    unverifiedObservations: federated.reduce((a, f) => a + f.unverifiedUpstream, 0),
  };
}


/**
 * The bundle this cairn publishes, built in ONE place.
 *
 * It existed only inside the HTTP route, so writing it to a file meant
 * rewriting it — and the rewrite drifted immediately: `publishedAt` instead of
 * `generatedAt`, which the consumer's own schema requires. The local path would
 * have failed validation the first time anybody used it, and the two ways of
 * federating would have disagreed about the shape of the thing they exchange.
 */
export function federationBundle(): {
  _notice: string;
  _untrustedFields: readonly string[];
  origin: string;
  generatedAt: string;
  findings: unknown[];
  keys: unknown[];
} {
  return {
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    origin: loadConfig().origin,
    generatedAt: new Date().toISOString(),
    /*
     * Shared findings only, and this is the enforcement rather than a
     * reminder. A corpus holds two kinds of record written in the same
     * sessions: one describing an organisation's own state, which nobody
     * outside can act on and which must never leave, and one describing how a
     * platform behaves for everyone, which is the whole point of publishing.
     * Filtering here means a corpus can be published without anyone auditing
     * it finding by finding, and that a mistake in the audit cannot leak
     * anything.
     */
    findings: loadCorpus().filter((f) => f.visibility === 'shared'),
    // Only keys minted here. Re-publishing an upstream's keys would launder
    // its identities downstream as though we vouched for them.
    keys: [...loadKeys().values()].filter((k) => !k.origin),
  };
}

/**
 * A finding carrying where it came from, for the paths that search.
 *
 * The id stays NATIVE. Namespacing it would be the obvious way to avoid
 * collisions and it silently breaks every upstream signature, because
 * confidence verifies observations against the finding id (decay.ts:149).
 * `displayId` carries the namespaced form for anything user-facing.
 */
export interface SearchableFinding extends Finding {
  upstreamName?: string;
  upstreamOrigin?: string;
  displayId?: string;
  /**
   * The key map this finding's observations verify against, carried with it.
   * decay.ts reads it instead of defaulting to the local map, so every
   * consumer -- confidence, standing, corroboration, serialize, doctor,
   * graph -- agrees without anyone threading an argument.
   */
  keys?: Map<string, KeyRecord>;
}

export interface Searchable {
  findings: SearchableFinding[];
}

/**
 * Everything this installation can answer from: its own corpus, plus every
 * upstream it subscribes to.
 *
 * This is the merge point the two-tier design always described and never
 * had. loadCorpus() reads only the local directory, and loadFederated() was
 * consumed by the federation web page and by `observe`, so `find` and
 * `brief` -- the only two things anybody actually runs -- never saw an
 * upstream finding. A personal corpus with forty findings cached from its
 * upstream answered "No corpus found."
 */
export function loadSearchable(): Searchable {
  const local: SearchableFinding[] = loadCorpus();
  const localKeys = loadKeys();
  const findings: SearchableFinding[] = [...local];

  const config = loadConfig();
  for (const up of config.upstreams) {
    const bundle = readBundle(up.name);
    if (!bundle) continue;
    const { keys: upstreamKeys } = bundleKeys(bundle);

    /*
     * The overlay is signed by local keys and the upstream body by upstream
     * keys, so verification needs both -- scoped to this finding, never
     * folded into the map that verifies local findings. A local finding
     * carries no map at all and falls back to loadKeys(), so an upstream can
     * never publish a key under a local agent's label and have it verify a
     * local observation.
     */
    const merged = new Map<string, KeyRecord>(upstreamKeys);
    for (const [id, rec] of localKeys) merged.set(id, rec);

    for (const finding of bundle.findings) {
      const entry: SearchableFinding = {
        ...finding,
        observations: [...finding.observations, ...readOverlay(up.name, finding.id)],
        upstreamName: up.name,
        upstreamOrigin: bundle.origin,
        displayId: federatedId(up.name, finding.id),
        keys: merged,
      };
      findings.push(entry);
    }
  }

  return { findings };
}
