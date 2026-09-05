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
import crypto from 'crypto';
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
    if (deriveKeyId(record.publicKey) !== record.keyId) continue;
    /*
     * Prove the private half REALLY corresponds to the published public key —
     * a sign/verify round-trip, not just the keyId check above (which only
     * re-derives the public key's id). A restored/copied/mismatched .key would
     * otherwise sign every observation as `broken` and commit them.
     */
    try {
      const probe = Buffer.from('cairn-key-probe');
      const sig = crypto.sign(null, probe, crypto.createPrivateKey(privateKey));
      if (!crypto.verify(null, probe, crypto.createPublicKey(record.publicKey), sig)) continue;
    } catch {
      continue; // unparseable/mismatched key material
    }
    return { keyId: record.keyId, label: record.label, record, privateKey };
  }
  return null;
}

/**
 * The signing journal — the fix for autoseal being a signing oracle.
 *
 * `by` is caller-supplied on every write path (a model calls cairn_observe /
 * cairn_record and picks its own `by`). So signing every unsigned observation
 * whose `by` matches the machine label let a model plant `by: "<operator>"` and
 * have it signed with the operator's key — a fabricated confirmation that then
 * verifies. The label proves nothing about authorship.
 *
 * So autoseal no longer signs by label alone. A TRUSTED local write path (the
 * operator's CLI, origin != agent) journals the observations it authored as this
 * machine, in .cairn-secrets (gitignored, never leaves), and autoseal signs ONLY
 * those. A model's observation is never journaled, so it is never auto-signed —
 * it stays unsigned, attributable to nobody, exactly as an unverifiable claim
 * should be.
 */
function journalPath(): string | null {
  try {
    return homePath('.cairn-secrets', 'pending-signatures.jsonl');
  } catch {
    return null;
  }
}

/** Mark an observation this machine authored (via a trusted path) as eligible for autoseal. Never throws. */
export function journalForSelfSign(findingId: string, at: string): void {
  const p = journalPath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.appendFileSync(p, JSON.stringify({ f: findingId, at }) + '\n');
  } catch {
    /* best-effort: worst case the observation stays unsigned, never wrongly signed */
  }
}

function readJournal(): { set: Set<string>; entries: Array<{ f: string; at: string }> } {
  const p = journalPath();
  const entries: Array<{ f: string; at: string }> = [];
  const set = new Set<string>();
  if (!p) return { set, entries };
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { f?: unknown; at?: unknown };
        if (typeof e.f === 'string' && typeof e.at === 'string') { entries.push({ f: e.f, at: e.at }); set.add(`${e.f}|${e.at}`); }
      } catch { /* skip a torn line */ }
    }
  } catch { /* no journal yet */ }
  return { set, entries };
}

function pruneJournal(signedKeys: Set<string>): void {
  const p = journalPath();
  if (!p) return;
  const { entries } = readJournal();
  const kept = entries.filter((e) => !signedKeys.has(`${e.f}|${e.at}`));
  try {
    if (kept.length) writeJsonAtomic(p, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
    else fs.rmSync(p, { force: true });
  } catch { /* best-effort */ }
}

/**
 * Sign every unsigned observation this machine JOURNALLED as its own (and whose
 * `by` matches the identity's label). Returns how many it signed. Never signs an
 * observation it did not itself journal — see journalForSelfSign.
 */
export function sealOwnObservations(id: MachineIdentity): number {
  let dir: string;
  try {
    dir = homePath('cairn');
  } catch {
    return 0;
  }
  const { set: eligible } = readJournal();
  if (!eligible.size) return 0;
  const signedKeys = new Set<string>();
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
      // Signed already, not ours by label, or not one we journalled: leave it.
      if (o.signature || o.by !== id.label || !eligible.has(`${f.id}|${o.at}`)) return row;
      const { signature: _drop, ...unsigned } = o;
      const value = signObservation(f.id, unsigned, id.privateKey, findingBodyHash(f, CURRENT_HASH_VERSION));
      touched = true;
      signed++;
      signedKeys.add(`${f.id}|${o.at}`);
      return { ...row, hashVersion: CURRENT_HASH_VERSION, signature: { algorithm: 'ed25519', keyId: id.keyId, value } };
    });
    if (touched) writeJsonAtomic(full, raw);
  }
  if (signedKeys.size) pruneJournal(signedKeys);
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
