/**
 * A machine's signing identity, created on demand — so nobody has to run keygen
 * as a separate step. Install calls this; keygen calls this; both get the same
 * key for the same label, generated once and reused after.
 *
 * The private half is generated HERE, on this machine, and written to
 * .cairn-secrets/ — it never travels through a chat, a request, or a remote
 * (cairn-0014). That is exactly why install can create it and a chat assistant
 * cannot: a key is only ever born where it will live.
 */
import fs from 'fs';
import path from 'path';
import { generateKeypair, keyFingerprint } from './signing';
import { loadKeys } from './keys';
import { homePath } from './home';

export interface Identity {
  keyId: string;
  fingerprint: string;
  label: string;
  /** True if this call generated the key; false if the label already had one. */
  created: boolean;
}

/**
 * Return the identity for `label`, generating and persisting it if the label has
 * no key yet. Idempotent: a second call with the same label returns the existing
 * key, never a duplicate (attribution is by label, so two keys under one label
 * would each be able to sign as that author).
 */
export function ensureIdentity(label: string): Identity {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('an identity needs a non-empty label');

  const existing = [...loadKeys().values()].find((k) => k.label === trimmed);
  if (existing) {
    return { keyId: existing.keyId, fingerprint: keyFingerprint(existing.publicKey), label: trimmed, created: false };
  }

  const { record, privateKey } = generateKeypair(trimmed);
  const keyFile = homePath('keys', `${record.keyId}.json`);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${JSON.stringify(record, null, 2)}\n`);

  const secretDir = homePath('.cairn-secrets');
  fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(secretDir, `${record.keyId}.key`), privateKey, { mode: 0o600 });

  return { keyId: record.keyId, fingerprint: keyFingerprint(record.publicKey), label: trimmed, created: true };
}
