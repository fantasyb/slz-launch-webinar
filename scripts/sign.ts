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
import crypto from 'crypto';
import { writeJsonAtomic } from '../src/lib/cairn/atomic';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';
import { signObservation, deriveKeyId, findingBodyHash, CURRENT_HASH_VERSION } from '../src/lib/cairn/signing';
import { loadKeys } from '../src/lib/cairn/keys';
import { homePath } from '../src/lib/cairn/home';

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
const privFile = homePath('.cairn-secrets', `${keyId}.key`);
if (!fs.existsSync(privFile)) {
  console.error(`private key not found at ${path.relative(process.cwd(), privFile)}`);
  process.exit(2);
}
const privateKey = fs.readFileSync(privFile, 'utf8');
if (deriveKeyId(key.publicKey) !== keyId) {
  console.error('published key material does not match its id');
  process.exit(2);
}

// Prove the private half matches the published public half BEFORE writing
// anything. Checking only that the published record is self-consistent meant a
// wrong-but-valid private key -- a restored backup, a file copied from another
// identity -- signed the whole corpus, printed success, exited 0, and left
// every signature verifying as `broken` for someone else to repair by hand.
try {
  const probe = Buffer.from('cairn-key-probe', 'utf8');
  const sig = crypto.sign(null, probe, crypto.createPrivateKey(privateKey));
  if (!crypto.verify(null, probe, crypto.createPublicKey(key.publicKey), sig)) {
    console.error(`the private key at ${path.relative(process.cwd(), privFile)} is not the`);
    console.error(`private half of the published key ${keyId}. Refusing to sign.`);
    process.exit(2);
  }
} catch (e) {
  console.error(`cannot use the private key: ${(e as Error).message}`);
  process.exit(2);
}

const DIR = homePath('cairn');
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
    const value = signObservation(f.id, unsigned, privateKey, findingBodyHash(f, CURRENT_HASH_VERSION));
    touched = true;
    signed++;
    return { ...raw.observations[i], hashVersion: CURRENT_HASH_VERSION, signature: { algorithm: 'ed25519', keyId, value } };
  });

  if (touched) writeJsonAtomic(full, raw);
}

console.log(`signed ${signed} observation(s) as "${key.label}" (${keyId})`);
if (skipped) console.log(`skipped ${skipped} belonging to other agents`);
// "Nothing to do" is not the same as "signed something", and a caller that
// only reads the exit code could not tell them apart.
if (signed === 0) process.exit(3);
