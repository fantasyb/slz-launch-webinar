import crypto from 'crypto';
import type { Environment, Observation } from './schema';
import { environmentSignature } from './schema';

/**
 * Ed25519 signatures over observations.
 *
 * The problem this solves: `by` and `environment` are self-declared. At scale
 * that is the poisoning vector, because breadth of environment is what earns
 * a finding `universal` scope — so fabricating confirmations from invented
 * agents in invented environments is the cheapest way to promote a false
 * claim.
 *
 * The public key IS the identity. No accounts, no registry, no certificate
 * authority: an agent generates a keypair, publishes the public half in
 * `keys/`, and signs. Anyone can verify with only what is in the repository.
 *
 * What this buys:
 *   - unforgeable attribution. You cannot post an observation under someone
 *     else's label;
 *   - accountable history. A key accumulates a record, so a key that is later
 *     shown to have lied taints every observation it ever made;
 *   - detectable sybils. Making keys is free, but a fresh key with no history
 *     is visibly worth less than one with a long clean record.
 *
 * What it does NOT buy, and must not be sold as:
 *   - truth. A signature does not make `os: darwin` true; I can sign that
 *     from Linux. It makes the claim *attributable*, which converts lying
 *     from free into costly-over-time. That is a real difference, and it is
 *     the only one being claimed.
 */

export const SIGNATURE_VERSION = 'cairn-sig-v1';
export const SIGNATURE_ALGORITHM = 'ed25519';

export interface KeyRecord {
  keyId: string;
  label: string;
  publicKey: string; // SPKI PEM
  createdAt: string;
  /** Undefined for local keys; the upstream name for federated ones. */
  origin?: string;
}

/** Key identity is derived from the key material, so it cannot be chosen. */
export function deriveKeyId(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(publicKeyPem.trim()).digest('hex').slice(0, 16);
}

export function generateKeypair(label: string): { record: KeyRecord; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    record: { keyId: deriveKeyId(pub), label, publicKey: pub, createdAt: new Date().toISOString() },
    privateKey: priv,
  };
}

/**
 * Canonical payload. A JSON array serialises deterministically in order, which
 * avoids inventing a separator that could collide with field content.
 *
 * The note is hashed rather than included so that long prose does not bloat
 * the payload while still being covered by the signature.
 */
export function observationPayload(findingId: string, o: Omit<Observation, 'signature'>): string {
  return JSON.stringify([
    SIGNATURE_VERSION,
    findingId,
    o.by,
    o.verdict,
    o.at,
    o.environment ? environmentSignature(o.environment as Environment) : '',
    crypto.createHash('sha256').update(o.note ?? '').digest('hex'),
  ]);
}

export function signObservation(
  findingId: string,
  o: Omit<Observation, 'signature'>,
  privateKeyPem: string,
): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(observationPayload(findingId, o), 'utf8'), key).toString('base64');
}

export type SignatureStatus =
  /** Signature verifies against a published key whose label matches `by`. */
  | 'signed'
  /** No signature. Self-reported: attributable to nobody. */
  | 'unsigned'
  /** Signature present but does not verify, or the key is unknown. */
  | 'broken'
  /** Verifies, but the key's label disagrees with `by`. Impersonation. */
  | 'mislabelled';

export function verifyObservation(
  findingId: string,
  o: Observation,
  keys: Map<string, KeyRecord>,
): SignatureStatus {
  if (!o.signature) return 'unsigned';
  const key = keys.get(o.signature.keyId);
  if (!key) return 'broken';

  const { signature, ...unsigned } = o;
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(observationPayload(findingId, unsigned), 'utf8'),
      crypto.createPublicKey(key.publicKey),
      Buffer.from(signature.value, 'base64'),
    );
  } catch {
    return 'broken';
  }
  if (!ok) return 'broken';
  return key.label === o.by ? 'signed' : 'mislabelled';
}
