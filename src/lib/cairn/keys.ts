import fs from 'fs';
import path from 'path';
import { deriveKeyId, validateLabel, type KeyRecord } from './signing';

/**
 * Published public keys live in `keys/`, in git. Verification therefore needs
 * nothing but a clone: no key server, no network, no trusted third party.
 */
export const KEYS_DIR = path.join(process.cwd(), 'keys');

let cache: Map<string, KeyRecord> | null = null;

/**
 * Keys published in this repository, and nothing else.
 *
 * This is the default because key scope decides what a *local* finding is
 * verified against, and `.cairn-cache/` is gitignored. Folding federated keys
 * into the same map made lint's verdict depend on whether the machine happened
 * to have federated recently: an upstream key under a label this repo does not
 * use could verify a local observation on a developer's machine and fail in
 * CI, so two runs of the same lint over the same corpus disagreed about
 * whether it was valid. Federated verification is a different question and now
 * has to be asked explicitly.
 */
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

  return (cache = map);
}

