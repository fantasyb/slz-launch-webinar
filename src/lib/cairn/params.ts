/**
 * Numeric query parameters, parsed strictly.
 *
 * `Number(searchParams.get('minConfidence') ?? 0)` returns NaN for anything
 * non-numeric, and every comparison against NaN is false — so
 * `?minConfidence=high` returned 200 with an empty list, indistinguishable
 * from "nothing meets your threshold". An agent filtering a corpus cannot tell
 * a typo from a real absence, and the absence is the answer it acts on.
 *
 * Out-of-range values had the same shape: `?minConfidence=50` (meaning 50%)
 * silently matched nothing, because confidence is a fraction.
 */
export class BadParam extends Error {
  constructor(readonly param: string, readonly detail: string) {
    super(`${param}: ${detail}`);
  }
}

export function numberParam(
  raw: string | null,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadParam(raw, 'must be a number');
  if (n < bounds.min || n > bounds.max) {
    throw new BadParam(raw, `must be between ${bounds.min} and ${bounds.max}`);
  }
  return n;
}
