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

export const COMMITMENT_VERSION = 'cairn-v1';
export const COMMITMENT_ALGORITHM = 'sha256';

/** Field separator: a control character that cannot occur in any field. */
const SEP = String.fromCharCode(31);

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
  return [
    COMMITMENT_VERSION,
    p.findingId,
    p.by,
    p.priorConfirmed.toFixed(4),
    p.reasoning.trim(),
    p.anchor,
    p.nonce,
  ].join(SEP);
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
  const recomputed = computeCommitment({
    findingId,
    by: p.by,
    priorConfirmed: p.priorConfirmed,
    reasoning: p.reasoning,
    anchor: p.commitment.anchor,
    nonce: p.nonce,
  });
  return recomputed === p.commitment.hash ? 'verified' : 'broken';
}
