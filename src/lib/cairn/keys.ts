import fs from 'fs';
import path from 'path';
import { deriveKeyId, validateLabel, type KeyRecord } from './signing';

/**
 * Published public keys live in `keys/`, in git. Verification therefore needs
 * nothing but a clone: no key server, no network, no trusted third party.
 */
export const KEYS_DIR = path.join(process.cwd(), 'keys');
const CACHE_DIR = path.join(process.cwd(), '.cairn-cache');

let cache: Map<string, KeyRecord> | null = null;

export function loadKeys(): Map<string, KeyRecord> {
  if (cache) return cache;
  const map = new Map<string, KeyRecord>();
  if (!fs.existsSync(KEYS_DIR)) return (cache = map);

  for (const file of fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith('.json'))) {
    const rec = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, file), 'utf8')) as KeyRecord;
    // The id is derived from the key material, so a record cannot claim an id
    // it did not earn. Reject any that tries.
    if (deriveKeyId(rec.publicKey) !== rec.keyId) {
      throw new Error(`keys/${file}: keyId does not match the public key material`);
    }
    const labelProblem = validateLabel(rec.label);
    if (labelProblem) {
      throw new Error(`keys/${file}: ${labelProblem} — labels that render alike impersonate`);
    }
    map.set(rec.keyId, rec);
  }

  // Federated keys, so that observations arriving from an upstream can be
  // verified with the keys that upstream publishes.
  //
  // The impersonation guard lives here, at the trust boundary: an upstream
  // key whose label collides with a local identity is dropped. Otherwise a
  // hostile upstream could publish a key labelled with one of your agents and
  // sign observations that pass the label check.
  const localLabels = new Set([...map.values()].map((k) => k.label));
  if (fs.existsSync(CACHE_DIR)) {
    for (const file of fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'))) {
      const upstream = file.replace(/\.json$/, '');
      let bundle: { keys?: KeyRecord[] };
      try {
        bundle = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
      } catch {
        continue;
      }
      for (const rec of bundle.keys ?? []) {
        if (deriveKeyId(rec.publicKey) !== rec.keyId) continue;
        if (validateLabel(rec.label)) continue; // unrenderable or confusable label
        if (localLabels.has(rec.label)) continue; // impersonation attempt
        if (map.has(rec.keyId)) continue;
        map.set(rec.keyId, { ...rec, origin: upstream });
      }
    }
  }

  return (cache = map);
}
