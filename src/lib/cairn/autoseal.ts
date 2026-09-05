/**
 * Auto-seal — sign this machine's own findings and commit them, with nobody
 * doing it by hand. This is the "you don't write anything" half of the promise:
 * install gives the machine a key (identity.ts), the pipeline records findings
 * under that key's label, and this signs them and lands them in the corpus's git
 * history automatically.
 *
 * IDENTITY IS THE MACHINE'S KEY LABEL. signing.ts binds a signature to the
 * observation's `by` — a key may only sign observations whose `by` equals its own
 * label. So on this machine the accountable author is the machine's key label
 * (e.g. "joey.ahern"), findings recorded here carry that as `by`, and this signs
 * exactly those. It never signs another author's observation (that would verify as
 * mislabelled), so a shared corpus stays honestly attributed.
 *
 * COMMITTING IS LOCAL. It commits the corpus's own git repo; it never pushes. A
 * push sends real session evidence off the machine, which must stay a deliberate,
 * gated act (the redaction/secret surface), not a background side effect. Local
 * commits are what make the machine's contributions countable by the corpus's own
 * machinery — a differently-signed stone in git — without anything leaving.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadKeys } from './keys';
import { homePath, cairnHome } from './home';
import { FindingSchema } from './schema';
import { signObservation, findingBodyHash, CURRENT_HASH_VERSION, deriveKeyId, type KeyRecord } from './signing';
import { writeJsonAtomic } from './atomic';

export interface MachineIdentity {
  keyId: string;
  label: string;
  record: KeyRecord;
  privateKey: string;
}

/**
 * The identity this machine can sign with: a published key whose private half is
 * present in .cairn-secrets AND actually matches it. Null if there is none. If
 * more than one local key exists it returns the first that verifies — a machine
 * with multiple signing identities is not this design's normal case.
 */
export function machineIdentity(): MachineIdentity | null {
  for (const record of loadKeys().values()) {
    let privFile: string;
    try {
      privFile = homePath('.cairn-secrets', `${record.keyId}.key`);
    } catch {
      return null; // no corpus home resolvable
    }
    if (!fs.existsSync(privFile)) continue;
    let privateKey: string;
    try {
      privateKey = fs.readFileSync(privFile, 'utf8');
    } catch {
      continue;
    }
    /* Prove the private half is really this key's before trusting it to sign. */
    if (deriveKeyId(record.publicKey) !== record.keyId) continue;
    return { keyId: record.keyId, label: record.label, record, privateKey };
  }
  return null;
}

/** Sign every unsigned observation authored by `id.label`. Returns how many it signed. */
export function sealOwnObservations(id: MachineIdentity): number {
  let dir: string;
  try {
    dir = homePath('cairn');
  } catch {
    return 0;
  }
  let signed = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const full = path.join(dir, file);
    let raw: Record<string, unknown> & { observations?: unknown[] };
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const parsed = FindingSchema.safeParse(raw);
    if (!parsed.success) continue;
    const f = parsed.data;
    let touched = false;
    raw.observations = f.observations.map((o, i) => {
      const row = (raw.observations as Record<string, unknown>[])[i];
      if (o.signature || o.by !== id.label) return row;
      const { signature: _drop, ...unsigned } = o;
      const value = signObservation(f.id, unsigned, id.privateKey, findingBodyHash(f, CURRENT_HASH_VERSION));
      touched = true;
      signed++;
      return { ...row, hashVersion: CURRENT_HASH_VERSION, signature: { algorithm: 'ed25519', keyId: id.keyId, value } };
    });
    if (touched) writeJsonAtomic(full, raw);
  }
  return signed;
}

/** True if the corpus home is inside a git work tree. */
function isGitRepo(home: string): boolean {
  try {
    execFileSync('git', ['-C', home, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit the corpus locally (never push). Returns true if a commit was made.
 * Stages the finding and key files only; a nothing-to-commit state is not an error.
 */
export function commitCorpus(home: string, message: string): boolean {
  if (!isGitRepo(home)) return false;
  try {
    execFileSync('git', ['-C', home, 'add', 'cairn', 'keys'], { stdio: 'ignore' });
    /* Nothing staged -> git commit exits non-zero; that is a no-op, not a failure. */
    const status = execFileSync('git', ['-C', home, 'status', '--porcelain', '--', 'cairn', 'keys'], { encoding: 'utf8' });
    if (!status.trim()) return false;
    execFileSync('git', ['-C', home, 'commit', '-q', '-m', message], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface SealResult {
  identity: string | null;
  signed: number;
  committed: boolean;
}

/**
 * The behind-the-scenes step: sign this machine's own unsigned observations and
 * commit the corpus locally. Safe to call any time — it no-ops when there is no
 * identity, nothing to sign, or no git repo. Never throws.
 */
export function sealAndCommit(message = 'cairn: sign and record findings'): SealResult {
  try {
    const id = machineIdentity();
    if (!id) return { identity: null, signed: 0, committed: false };
    const signed = sealOwnObservations(id);
    let committed = false;
    try {
      committed = commitCorpus(cairnHome(), message);
    } catch {
      /* corpus home unresolved; signing still happened */
    }
    return { identity: id.label, signed, committed };
  } catch {
    return { identity: null, signed: 0, committed: false };
  }
}
