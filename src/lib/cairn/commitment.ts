import crypto from 'crypto';

/**
 * Commit-reveal, anchored in git history.
 *
 * The prediction ledger is only worth anything if a forecast provably
 * preceded the outcome. A self-declared `blind: true` proves nothing: a
 * contributor can read the evidence and then write a matching prediction.
 *
 * So the protocol has two phases.
 *
 *   SEAL    Publish only H(prediction || nonce || anchor). The prior and the
 *           reasoning stay secret, on disk, gitignored. This commit is pushed
 *           BEFORE the check is run.
 *   REVEAL  Publish the prior, the reasoning and the nonce. Anyone recomputes
 *           the hash and confirms it matches the seal.
 *
 * What this proves:
 *   - the prediction content is immutable: it cannot be edited to match the
 *     outcome, because the hash was published first;
 *   - it existed at a specific, verifiable point in the repo's public history;
 *   - the predictor had not seen other sealed predictions' contents.
 *
 * What it does not prove:
 *   - that the predictor had not privately run the check before sealing.
 *     Nothing short of trusted execution closes that, and pretending
 *     otherwise would be the same error this corpus exists to correct. It is
 *     mitigated instead: self-predictions are excluded from scoring, and an
 *     agent whose Brier score is implausibly good across many findings is
 *     detectable. Calibration that is too good is itself the fraud signal.
 *
 * `anchor` is the repo HEAD sha at seal time. Including it binds the
 * commitment to a state of history the predictor could not have constructed
 * in advance, which bounds the interval from below.
 */

export const COMMITMENT_VERSION = 'cairn-v2';
export const LEGACY_COMMITMENT_VERSION = 'cairn-v1';
export const COMMITMENT_ALGORITHM = 'sha256';

/**
 * v1 joined the fields with U+001F and asserted in a comment that the
 * separator "cannot occur in any field". Nothing enforced that, and two of the
 * joined fields — `by` and `reasoning` — are free text the schema happily
 * accepts control characters in. The encoding was therefore not prefix-free,
 * and the boundary between those fields could be moved:
 *
 *   A: by "alice",              prior 0.9, reasoning "R\x1f0.5000\x1fBBBB…"
 *   B: by "alice\x1f0.9000\x1fR", prior 0.5, reasoning "BBBB…"
 *
 * Both are valid predictions, both serialise to the same string, and both hash
 * to 7536275484…. A predictor could seal once and then, having seen the check
 * result, reveal either a 0.9 or a 0.5 prior — with the published hash
 * verifying in both cases. That is exactly the property this file exists to
 * provide, and v1 did not have it.
 *
 * v2 uses JSON array encoding, which is injective: the escaping makes the
 * field boundaries unambiguous no matter what the fields contain. It is the
 * same construction blockPayload already used. As a side effect it also fixes
 * the lone-surrogate collision (a JSON escape distinguishes U+D800 from the
 * U+FFFD that utf8 encoding would have replaced it with).
 */
const LEGACY_SEP = String.fromCharCode(31);

export interface Preimage {
  findingId: string;
  by: string;
  priorConfirmed: number;
  reasoning: string;
  anchor: string;
  nonce: string;
}

/**
 * Canonical serialisation. Any change here invalidates every existing
 * commitment, so the version prefix is part of the hashed string.
 *
 * priorConfirmed is fixed to 4 decimal places so that 0.75 and 0.7500 cannot
 * produce different hashes for the same forecast.
 */
export function canonicalPreimage(p: Preimage): string {
  // No .trim() here. Trimming inside the preimage meant a sealed "why" and a
  // revealed "  why  " hashed identically, so the revealed text did not have
  // to be the sealed text. Callers trim before sealing; the preimage commits
  // to exactly the string that gets published.
  return JSON.stringify([
    COMMITMENT_VERSION,
    p.findingId,
    p.by,
    p.priorConfirmed.toFixed(4),
    p.reasoning,
    p.anchor,
    p.nonce,
  ]);
}

/** The v1 encoding, retained only so existing seals can still be identified. */
function legacyPreimage(p: Preimage): string {
  return [
    LEGACY_COMMITMENT_VERSION,
    p.findingId,
    p.by,
    p.priorConfirmed.toFixed(4),
    p.reasoning.trim(),
    p.anchor,
    p.nonce,
  ].join(LEGACY_SEP);
}

export function computeCommitment(p: Preimage): string {
  return crypto
    .createHash(COMMITMENT_ALGORITHM)
    .update(canonicalPreimage(p), 'utf8')
    .digest('hex');
}

export function generateNonce(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export type CommitmentStatus =
  /** Sealed and revealed, and the hash recomputes correctly. */
  | 'verified'
  /** Sealed, not yet revealed. Prior and reasoning are still secret. */
  | 'sealed'
  /** Revealed but the hash does not match. Tampered or malformed. */
  | 'broken'
  /**
   * Recomputes only under the v1 encoding, which was not prefix-free and so
   * did not bind the field values. The seal is intact and its date is still
   * evidence of when something was committed to; it is not evidence of WHAT.
   * Displayed, never scored.
   */
  | 'legacy-encoding'
  /** No commitment at all: self-reported, untrustworthy, never scored. */
  | 'unanchored';

export function commitmentStatus(
  findingId: string,
  p: {
    by: string;
    priorConfirmed?: number;
    reasoning?: string;
    nonce?: string;
    commitment?: { hash: string; anchor: string };
  },
): CommitmentStatus {
  if (!p.commitment) return 'unanchored';
  if (p.priorConfirmed === undefined || p.reasoning === undefined || !p.nonce) {
    return 'sealed';
  }
  const preimage = {
    findingId,
    by: p.by,
    priorConfirmed: p.priorConfirmed,
    reasoning: p.reasoning,
    anchor: p.commitment.anchor,
    nonce: p.nonce,
  };
  if (computeCommitment(preimage) === p.commitment.hash) return 'verified';

  // Seals made before the encoding was fixed are reported as what they are,
  // rather than as tampering, and are excluded from scoring either way.
  const legacy = crypto
    .createHash(COMMITMENT_ALGORITHM)
    .update(legacyPreimage(preimage), 'utf8')
    .digest('hex');
  if (legacy === p.commitment.hash) return 'legacy-encoding';

  return 'broken';
}
