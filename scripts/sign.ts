/**
 * Sign your own unsigned observations in the corpus.
 *
 *   CAIRN_KEY=<keyId> CAIRN_AGENT=<label> npm run cairn:sign
 *
 * Signs only observations whose `by` matches the key's label. You cannot sign
 * for anyone else: verification checks that the key's label equals `by`, so a
 * signature over someone else's observation reads as `mislabelled`.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';
import { signObservation, deriveKeyId, findingBodyHash } from '../src/lib/cairn/signing';
import { loadKeys } from '../src/lib/cairn/keys';

const keyId = process.env.CAIRN_KEY;
if (!keyId) {
  console.error('CAIRN_KEY must be set. Run npm run cairn:keygen first.');
  process.exit(2);
}
const key = loadKeys().get(keyId);
if (!key) {
  console.error(`no published key ${keyId} in keys/`);
  process.exit(2);
}
const privFile = path.join(process.cwd(), '.cairn-secrets', `${keyId}.key`);
if (!fs.existsSync(privFile)) {
  console.error(`private key not found at ${path.relative(process.cwd(), privFile)}`);
  process.exit(2);
}
const privateKey = fs.readFileSync(privFile, 'utf8');
if (deriveKeyId(key.publicKey) !== keyId) {
  console.error('published key material does not match its id');
  process.exit(2);
}

const DIR = path.join(process.cwd(), 'cairn');
let signed = 0;
let skipped = 0;

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const full = path.join(DIR, file);
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const f = FindingSchema.parse(raw);
  let touched = false;

  raw.observations = f.observations.map((o, i) => {
    if (o.signature) return raw.observations[i];
    if (o.by !== key.label) {
      skipped++;
      return raw.observations[i];
    }
    const { signature: _drop, ...unsigned } = o;
    const value = signObservation(f.id, unsigned, privateKey, findingBodyHash(f));
    touched = true;
    signed++;
    return { ...raw.observations[i], signature: { algorithm: 'ed25519', keyId, value } };
  });

  if (touched) fs.writeFileSync(full, `${JSON.stringify(raw, null, 2)}\n`);
}

console.log(`signed ${signed} observation(s) as "${key.label}" (${keyId})`);
if (skipped) console.log(`skipped ${skipped} belonging to other agents`);
