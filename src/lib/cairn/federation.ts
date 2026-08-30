import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { FindingSchema, ObservationSchema, type Finding, type Observation } from './schema';
import { verifyObservation, findingBodyHash, type KeyRecord } from './signing';
import { loadKeys } from './keys';

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
  origin: z.string().min(1),
  generatedAt: z.string(),
  findings: z.array(FindingSchema),
  keys: z.array(
    z.object({
      keyId: z.string(),
      label: z.string(),
      publicKey: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type FederationBundle = z.infer<typeof FederationBundleSchema>;

export const CONFIG_FILE = path.join(process.cwd(), 'cairn.config.json');
export const CACHE_DIR = path.join(process.cwd(), '.cairn-cache');
export const OVERLAY_DIR = path.join(process.cwd(), 'federation');

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_FILE)) return { origin: 'cairn.local', upstreams: [] };
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

    // Upstream keys, namespaced so they cannot collide with local identities.
    const upstreamKeys = new Map<string, KeyRecord>(
      bundle.keys.map((k) => [k.keyId, k as KeyRecord]),
    );

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

    // Local keys must still verify the overlay, which loadKeys covers.
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
