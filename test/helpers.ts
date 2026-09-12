import crypto from 'crypto';
import { deriveKeyId, signObservation, findingBodyHash, type KeyRecord } from '../src/lib/cairn/signing';
import type { Finding } from '../src/lib/cairn/schema';

export function makeKey(label: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { label, pub, priv, keyId: deriveKeyId(pub) };
}

export type TestKey = ReturnType<typeof makeKey>;

export function keyMap(...ks: TestKey[]): Map<string, KeyRecord> {
  return new Map(
    ks.map((k) => [k.keyId, { keyId: k.keyId, label: k.label, publicKey: k.pub, createdAt: '2026-01-01' }]),
  );
}

export const env = (os: string, runtime = 'node 22') => ({ os, arch: 'x64', runtime });

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'cairn-9999',
    title: 'test finding',
    claim: 'a claim long enough to satisfy the schema minimum for a claim field',
    scope: 'universal',
    basis: 'empirical',
    kind: 'trap',
    subject: { name: 's', ecosystem: 'e', versions: '*' },
    tags: [],
    cost: 'hours',
    expectation: 'e',
    reality: 'r',
    evidence: [],
    check: { command: 'x', confirmedIf: 'a', refutedIf: 'b', manual: true },
    provenance: 'firsthand',
    halfLifeDays: 180,
    observations: [],
    predictions: [],
    status: 'active',
    createdAt: '2026-08-01',
    ...overrides,
  } as Finding;
}

type ObsSpec = { at: string; by: string; verdict: 'confirmed' | 'refuted' | 'inconclusive'; environment?: unknown };

/** Build a finding whose signed observations verify against its own body. */
export function signedFinding(specs: Array<{ key?: TestKey; obs: ObsSpec }>, overrides: Partial<Finding> = {}): Finding {
  const shell = finding({ ...overrides, observations: specs.map((s) => s.obs) as Finding['observations'] });
  const body = findingBodyHash(shell);
  return finding({
    ...overrides,
    observations: specs.map(({ key, obs }) =>
      key
        ? {
            ...obs,
            signature: {
              algorithm: 'ed25519',
              keyId: key.keyId,
              value: signObservation(shell.id, obs as never, key.priv, body),
            },
          }
        : obs,
    ) as Finding['observations'],
  });
}
