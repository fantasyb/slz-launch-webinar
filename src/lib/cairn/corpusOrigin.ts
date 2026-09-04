/**
 * A corpus's origin — its globally-unique name, the `origin` field in
 * cairn.config.json that federation.ts namespaces ids with (`<origin>:cairn-0050`).
 *
 * THIS IS THE FIX FOR THE PHANTOM FINDING. Two corpora can each hold a
 * "cairn-0050", and the only thing that keeps them apart when they meet
 * (federation, a cross-reference, one machine reading another) is that namespaced
 * id. It is worth nothing if every corpus shares the same origin — and until now
 * every corpus without a config defaulted to the SAME string, "cairn.local"
 * (federation.ts loadConfig), so two corpora's ids collided exactly as if there
 * were no namespace. That is what made a reference to cairn-0050 resolve to a
 * different finding depending on which corpus was mounted, and a retro-sign fail
 * because the id "did not exist" in the corpus that happened to be there.
 *
 * So every corpus gets a distinct, stable origin the first time it is set up, and
 * never again — changing an origin would orphan every namespaced reference to it.
 *
 * (Distinct from origin.ts, which resolves this DEPLOYMENT's base URL for the web
 * app. That reads the same `origin` field but only when it looks like a URL; a
 * bare namespace like "pilot-9f3a2b" it correctly ignores as a non-deployment.)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** A readable, charset-safe stem for the origin from the corpus's location. */
function stem(homeDir: string): string {
  const base = path.basename(homeDir);
  const name = base === '.cairn' ? path.basename(path.dirname(homeDir)) : base;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length >= 2 ? slug : 'cairn';
}

/**
 * Return this corpus's origin, generating and persisting a unique one the first
 * time. Idempotent: an existing config's real origin is returned unchanged,
 * because a corpus's origin must be stable for the life of every reference to it.
 * A deployment's URL origin is left untouched; only an absent or placeholder
 * ("cairn.local") origin is filled in.
 *
 * `homeDir` is the corpus home (the directory that contains cairn/). Operates on
 * the path directly rather than through CAIRN_HOME, so install and project-init
 * can each set up their own corpus.
 */
export function ensureOrigin(homeDir: string): { origin: string; created: boolean } {
  const cfgFile = path.join(homeDir, 'cairn.config.json');
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (typeof cfg.origin === 'string' && cfg.origin && cfg.origin !== 'cairn.local') {
        return { origin: cfg.origin, created: false };
      }
      const origin = `${stem(homeDir)}-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, origin }, null, 2) + '\n');
      return { origin, created: true };
    } catch {
      /* malformed config: fall through and write a clean one */
    }
  }
  const origin = `${stem(homeDir)}-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ origin, upstreams: [] }, null, 2) + '\n');
  return { origin, created: true };
}
