/**
 * The origin this deployment speaks for.
 *
 * Everything that hands an adopter a URL — the install block, /skill.md,
 * /install.md — has to name a host, and the obvious source is the request's
 * own Host header. That is fine for a page a human reads and fatal for
 * anything signed: `curl -H 'Host: evil.example' https://real-cairn/api/block`
 * returned a block whose every curl URL pointed at evil.example, signed by the
 * genuine key, verifying against the genuine fingerprint. An adopter who did
 * everything right — pinned the fingerprint out of band, checked the signature
 * — installed an agent instruction file aimed at the attacker. The signature
 * is sold as proving the block came from the real corpus; a Host-derived base
 * turned it into an oracle that signs whatever origin the caller names.
 *
 * So the canonical origin comes from configuration the caller cannot touch,
 * and a request arriving under any other Host is served, but never signed.
 */
import fs from 'fs';
import path from 'path';
import { homePath } from './home';

export type Origin = {
  /** The base URL to put in served documents. */
  base: string;
  /** True when it came from configuration rather than the request. */
  canonical: boolean;
  /** Why it is not canonical. Absent when it is. */
  reason?: 'unconfigured' | 'host-mismatch';
};

let configured: string | null | undefined;

function fromConfig(): string | null {
  if (configured !== undefined) return configured;
  const env = process.env.CAIRN_BASE_URL?.trim();
  if (env) return (configured = normalise(env));
  try {
    const raw = JSON.parse(
      fs.readFileSync(homePath('cairn.config.json'), 'utf8'),
    ) as { origin?: string };
    const o = raw.origin?.trim();
    // A bare name like "cairn.local" is a placeholder, not a deployment.
    if (o && /^https?:\/\//.test(o)) return (configured = normalise(o));
  } catch {
    /* no config, or unreadable — treated as unconfigured */
  }
  return (configured = null);
}

function normalise(u: string): string {
  return u.replace(/\/+$/, '');
}

/**
 * Resolve the base URL for a request. `canonical` is false when this
 * deployment has no configured origin, or when the request arrived under a
 * different Host than the configured one — in both cases the result must not
 * be signed.
 */
export function resolveOrigin(request: Request): Origin {
  const host = request.headers.get('host') ?? 'CAIRN_HOST';
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  const requested = normalise(`${proto}://${host}`);

  const canonicalBase = fromConfig();
  if (!canonicalBase) return { base: requested, canonical: false, reason: 'unconfigured' };
  if (requested !== canonicalBase) {
    // Serve the canonical base, not the one asked for: a caller must not see
    // its own chosen host reflected back in a document meant to name us.
    return { base: canonicalBase, canonical: false, reason: 'host-mismatch' };
  }
  return { base: canonicalBase, canonical: true };
}

/** Test seam: forget the memoised configuration. */
export function resetOriginCache(): void {
  configured = undefined;
}
