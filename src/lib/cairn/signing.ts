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

export const SIGNATURE_VERSION = 'cairn-sig-v2';

/**
 * Hash of the substantive body of a finding.
 *
 * v1 signed only the observation — who, what verdict, when, where. It did not
 * cover the finding's own text, so amending a trusted finding's `workaround`
 * left every signature verifying. That is the highest-value attack on a corpus
 * like this: poisoning advice that agents already rely on is worth far more
 * than introducing an unknown finding, and it was invisible.
 *
 * An observation now attests to the body it was made against. Amending that
 * body invalidates prior attestations, which is not a limitation but the
 * correct semantics: "I ran this check and saw this" is a statement about a
 * specific claim and a specific check, and it stops being true when either
 * changes. A legitimate editor re-signs, which needs the key; an attacker
 * cannot, and CI refuses a body no observation attests to.
 *
 * Deliberately excludes observations, predictions, tags and timestamps — those
 * change as the corpus lives, and folding them in would invalidate everything
 * on every append.
 */
export function findingBodyHash(f: {
  id: string;
  claim: string;
  expectation: string;
  reality: string;
  mechanism?: string;
  workaround?: string;
  derivation?: string;
  appliesTo?: string;
  scope: string;
  basis?: string;
  subject: { name: string; ecosystem: string; versions: string };
  check: { command: string; confirmedIf: string; refutedIf: string; manual: boolean };
  evidence: Array<{ command: string; output: string; note?: string }>;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        f.id, f.claim, f.expectation, f.reality,
        f.mechanism ?? '', f.workaround ?? '', f.derivation ?? '', f.appliesTo ?? '',
        f.scope, f.basis ?? 'empirical',
        f.subject.name, f.subject.ecosystem, f.subject.versions,
        f.check.command, f.check.confirmedIf, f.check.refutedIf, f.check.manual,
        f.evidence.map((e) => [e.command, e.output, e.note ?? '']),
      ]),
      'utf8',
    )
    .digest('hex');
}
export const SIGNATURE_ALGORITHM = 'ed25519';

export interface KeyRecord {
  keyId: string;
  label: string;
  publicKey: string; // SPKI PEM
  createdAt: string;
  /** Undefined for local keys; the upstream name for federated ones. */
  origin?: string;
}

/**
 * Full sha256 of the key material. This is what breaks the circularity in
 * fetching a key from the host you are trying to verify.
 *
 * The host may serve the public key; it cannot serve a DIFFERENT one, because
 * the adopter pinned a fingerprint that arrived through another channel — a
 * README, a package, a person — and a substituted key hashes to something
 * else. Producing a key that hashes to a chosen 128-bit prefix is a
 * second-preimage attack, which is why the pin must be long enough to be one.
 *
 * Same construction as an SSH host key fingerprint or a Signal safety number:
 * the secret is not the fingerprint, the fingerprint is the commitment.
 */
export function keyFingerprint(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(publicKeyPem.trim()).digest('hex');
}

/** Short handle for display and cross-reference. Never sufficient as a pin. */
export function deriveKeyId(publicKeyPem: string): string {
  return keyFingerprint(publicKeyPem).slice(0, 16);
}

/** Minimum pin length accepted when the key itself was fetched: 128 bits. */
export const MIN_PIN_HEX = 32;

export type PinResult =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: string; fingerprint?: string };

/**
 * Does a fetched public key match the fingerprint the adopter pinned?
 *
 * Rejects a pin too short to be safe against a second-preimage search, so a
 * user who pastes only the 16-character handle is told to use the full
 * fingerprint rather than silently given 64 bits of protection.
 */
export function checkPin(publicKeyPem: string, pinned: string): PinResult {
  const pin = pinned.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (pin.length < MIN_PIN_HEX) {
    return {
      ok: false,
      reason:
        `pin is ${pin.length} hex characters; at least ${MIN_PIN_HEX} (128 bits) are ` +
        `required when the key is fetched, because a shorter pin can be brute-forced ` +
        `by whoever serves the key`,
    };
  }
  const fingerprint = keyFingerprint(publicKeyPem);
  if (!fingerprint.startsWith(pin)) {
    return { ok: false, reason: 'fetched key does not match the pinned fingerprint', fingerprint };
  }
  return { ok: true, fingerprint };
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
export function observationPayload(
  findingId: string,
  o: Omit<Observation, 'signature'>,
  bodyHash: string,
): string {
  return JSON.stringify([
    SIGNATURE_VERSION,
    findingId,
    bodyHash,
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
  bodyHash: string,
): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto
    .sign(null, Buffer.from(observationPayload(findingId, o, bodyHash), 'utf8'), key)
    .toString('base64');
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
  bodyHash: string,
): SignatureStatus {
  if (!o.signature) return 'unsigned';
  const key = keys.get(o.signature.keyId);
  if (!key) return 'broken';

  const { signature, ...unsigned } = o;
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(observationPayload(findingId, unsigned, bodyHash), 'utf8'),
      crypto.createPublicKey(key.publicKey),
      Buffer.from(signature.value, 'base64'),
    );
  } catch {
    return 'broken';
  }
  if (!ok) return 'broken';
  return key.label === o.by ? 'signed' : 'mislabelled';
}
