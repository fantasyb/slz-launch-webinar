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
 * Catastrophic-backtracking guard.
 *
 * The input cap bounds LENGTH, not the exponent: `(a+)+$` against 26 `a`s then a
 * `b` already takes ~400ms and doubles per character, so a single such signature
 * — arriving in a federated bundle and re-tested against every tool result on the
 * gateway's main thread — freezes every session. Compiling successfully is not
 * enough; the pattern must also be structurally safe.
 *
 * We reject the two classic evil-regex shapes: a quantified group whose body
 * itself contains an unbounded quantifier (nested quantifiers — `(a+)+`, `(a*)*`,
 * `(.*)+`, `(?:a+){2,}`), and any backreference (`\1`), whose combination with a
 * quantifier is the other exponential class. Escapes and character classes are
 * skipped so `\(` and `[+*]` do not trip it. A trap marker never needs either
 * shape, so a false positive costs the author a rewrite, never a real signature.
 */
function isDangerousPattern(src: string): boolean {
  const open: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      if (/[1-9]/.test(src[i + 1] ?? '')) return true; // a backreference (outside a char class)
      i++;
      continue;
    }
    if (c === '[') { i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '(') open.push(i);
    else if (c === ')') {
      const start = open.pop();
      if (start === undefined) continue;
      if (outerUnbounded(src, i + 1) && bodyHasUnboundedQuantifier(src.slice(start + 1, i))) return true;
    }
  }
  return false;
}

/** Blank out character-class contents so `[\1]`/`[+]` don't read as a backreference/quantifier. */
function unclassed(src: string): string {
  return src.replace(/\\./g, '..').replace(/\[[^\]]*\]/g, '[]');
}

/** At position `i` (just past a `)`), is there an unbounded quantifier — `*`, `+`, or `{n,}`? Bounded `{n,m}` is safe. */
function outerUnbounded(src: string, i: number): boolean {
  const c = src[i];
  if (c === '*' || c === '+') return true;
  if (c === '{') {
    const m = src.slice(i).match(/^\{\d*,\}/); // open upper bound
    return !!m;
  }
  return false;
}

/** Does a group body contain an unbounded quantifier applied to something (an inner `*`, `+`, or `{n,}`)? */
function bodyHasUnboundedQuantifier(body: string): boolean {
  const s = unclassed(body);
  return /[*+]/.test(s) || /\{\d*,\}/.test(s);
}

/**
 * A signature is usable only if it compiles AND is structurally safe. Used by the
 * schema/lint to refuse a signature that could never fire or could hang the
 * gateway. (A dangerous pattern is rejected here, so it never reaches the corpus;
 * `resonates` also refuses it at runtime as defence in depth for older corpora.)
 */
export function isValidSignature(sig: string): boolean {
  try {
    new RegExp(sig, 's');
  } catch {
    return false;
  }
  return !isDangerousPattern(sig);
}

/**
 * Compiled-regex cache. A signature is compiled once, not per finding per result
 * (the gateway re-tests every finding against every result). A dangerous or
 * uncompilable pattern caches as `null` = permanently dormant.
 */
const compiled = new Map<string, RegExp | null>();
function compile(sig: string): RegExp | null {
  const hit = compiled.get(sig);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  if (isValidSignature(sig)) {
    try { re = new RegExp(sig, 's'); } catch { re = null; }
  } else {
    process.stderr.write(`cairn: finding signature is unsafe or invalid; treating as dormant\n`);
  }
  if (compiled.size > 2000) compiled.clear(); // bound the cache; corpora have far fewer signatures
  compiled.set(sig, re);
  return re;
}

/**
 * Does this finding's signature resonate with the live result? A finding without
 * a signature always resonates (it rings on its tool alone). A signature that is
 * uncompilable OR structurally dangerous is treated as dormant — never firing —
 * rather than crashing delivery, firing blindly, or hanging the event loop.
 */
export function resonates(finding: { signature?: string }, resultText: string): boolean {
  const sig = finding.signature;
  if (!sig) return true;
  const re = compile(sig);
  if (!re) return false;
  const text = typeof resultText === 'string' ? resultText : '';
  return re.test(text.slice(0, MAX_MATCH_CHARS));
}
