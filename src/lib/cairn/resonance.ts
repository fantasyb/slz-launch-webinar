/**
 * Resonance — a finding fires on a tool result only when the result shows the
 * trap actually manifesting, not merely because the tool was called.
 *
 * Nature does not search memory; it lets the cue resonate into the thing it is
 * bound to. A tuning fork stays silent until the exact frequency passes, then
 * rings on the wave's own energy. A `trigger` names the tool — the frequency
 * BAND the finding listens on. A `signature` is the exact frequency: a cheap
 * pattern over the live result that says "the trap is here, now."
 *
 * With no signature a finding rings whenever its tool is used (legacy, broad).
 * With one it stays dormant — costing nothing — until a result resonates. The
 * test is a plain regex over the serialized result: no model, no extra call,
 * evaluated in the same breath as the result the agent is already reading. So
 * the 99% of calls that do not hit the trap pay nothing, and the finding
 * surfaces at exactly the instant of need.
 */

/** Cap the text a signature is tested against: keeps the match cheap and bounds any pathological pattern. */
const MAX_MATCH_CHARS = 20_000;

/**
 * Does this finding's signature resonate with the live result? A finding
 * without a signature always resonates (it rings on its tool alone). A finding
 * whose signature is not a valid pattern is treated as dormant — never firing —
 * rather than crashing delivery or firing blindly; the corpus lint rejects such
 * a signature at record time, so this only guards a corpus that got past it.
 */
export function resonates(finding: { signature?: string }, resultText: string): boolean {
  const sig = finding.signature;
  if (!sig) return true;
  try {
    return new RegExp(sig, 's').test((resultText ?? '').slice(0, MAX_MATCH_CHARS));
  } catch (e) {
    process.stderr.write(`cairn: finding signature is not a valid pattern (${(e as Error).message}); treating as dormant\n`);
    return false;
  }
}

/** Whether a string compiles as a regex — used by the schema/lint to refuse a signature that could never fire. */
export function isValidSignature(sig: string): boolean {
  try {
    new RegExp(sig, 's');
    return true;
  } catch {
    return false;
  }
}
