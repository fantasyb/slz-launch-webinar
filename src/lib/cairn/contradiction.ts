/**
 * The contradiction-triggered writer: the shape cairn-0045 said to look for.
 *
 * A writer keyed on errors is blind to the traps worth recording, because
 * those return success with a plausible payload. What a success-shaped trap
 * does leave behind, within one session, is a CONTRADICTION: a call to a
 * tool with some arguments returns one thing, and a later call to the same
 * tool with those arguments plus more returns something the first result
 * had implied did not exist. The earlier default was wrong. Both halves of
 * the finding -- the misleading call and the corrected one -- are already in
 * hand, and this is the moment cairn-0034 says the knowledge is cheapest.
 *
 * Two shapes, from real findings rather than invented ones:
 *
 *   empty-then-nonempty   success with zero items, then a strict superset of
 *                         the arguments returns items. A stale mapping, a
 *                         wrong-org default, a scope that silently excluded
 *                         everything.
 *   more-with-superset    N items with nothing saying more existed, then a
 *                         strict superset returns more than N. A silent cap
 *                         behind an undocumented flag.
 *
 * NOISE IS FATAL HERE in a way it is not elsewhere: a "this looks like a
 * trap" on every third result trains the reader to skip the label that
 * carries the findings too. So every rule below is a rule for staying quiet:
 *
 *   - STRICT superset only. Every earlier argument present in the later call
 *     with the same value, plus at least one new one. A changed value on a
 *     shared key is a different question, not a corrected default, and
 *     `limit: 10` then `limit: 100` is the commonest shape of an ordinary
 *     session; it never fires.
 *   - A continuation is not a superset. Extra keys that name a cursor, token,
 *     offset or page are the next page of the same question.
 *   - A result that says how much more there is cannot be the misleading
 *     half. `next_cursor`, `has_more`, `total`, `done: false` -- a payload
 *     that declares its own incompleteness was not silent about it.
 *   - Only results that parse as JSON with something countable in them are
 *     compared. Prose, images and opaque blobs are never "empty" or "more".
 *   - Errors are the other writer's business (the hole-to-draft loop).
 *
 * Pure: no corpus, no disk, no clock. The gateway decides what to do with a
 * contradiction; this only says whether there is one.
 */

export interface CallSummary {
  args: Record<string, unknown>;
  /** Items in the result, or null when the result had nothing countable. */
  items: number | null;
  /** The result declared that more exists, or how much exists in total. */
  continuation: boolean;
  /** The result's own text, kept for the draft's evidence. */
  text: string;
  at: string;
}

export interface Contradiction {
  kind: 'empty-then-nonempty' | 'more-with-superset';
  earlier: CallSummary;
  later: CallSummary;
  /** The keys the later call added. */
  added: string[];
}

const CONTINUATION_KEYS = /^(next|next_?cursor|next_?page(_?token)?|next_?records_?url|cursor|has_?more|more|total|total_?size|total_?count|count|page|pages|paging|paginat\w*|done)$/i;
const CURSOR_ARGS = /cursor|token|offset|page/i;
/** Arguments that only bound how much comes back. A bound cannot turn nothing into something. */
const BOUND_ARGS = /^(limit|max|max_?results|max_?rows|top|page_?size|per_?page|size|count|n)$/i;

/** Items and continuation, read off a JSON result; null items when there is nothing to count. */
export function summarise(args: Record<string, unknown>, text: string, at = new Date().toISOString()): CallSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { args, items: null, continuation: false, text, at };
  }
  let items: number | null = null;
  let continuation = false;
  const look = (v: unknown, depth: number): void => {
    if (Array.isArray(v)) {
      items = Math.max(items ?? 0, v.length);
      return;
    }
    if (!v || typeof v !== 'object' || depth > 2) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (CONTINUATION_KEYS.test(k)) {
        if (k.toLowerCase() === 'done') { if (x === false) continuation = true; }
        else if (x !== null && x !== undefined && x !== false && x !== '' && !(Array.isArray(x) && x.length === 0)) continuation = true;
      }
      look(x, depth + 1);
    }
  };
  look(parsed, 0);
  return { args, items, continuation, text, at };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * The keys `later` adds to `earlier`, or null when it is not a strict
 * superset (or only continues it).
 *
 * `boundsMayDiffer` is for the empty case only: when the earlier call
 * returned nothing, a changed `limit` cannot be what produced the rows --
 * a bound cannot turn nothing into something -- so it is not a different
 * question. In the replay, one of five stale-mapping recoveries added
 * mapping_id and lowered limit in the same call, and the strict rule missed
 * it. For the more-with-superset shape a changed bound explains "more" all
 * by itself, and the strict rule stays.
 */
export function addedBy(earlier: Record<string, unknown>, later: Record<string, unknown>, boundsMayDiffer = false): string[] | null {
  for (const k of Object.keys(earlier)) {
    if (!(k in later)) return null;
    if (!deepEqual(earlier[k], later[k]) && !(boundsMayDiffer && BOUND_ARGS.test(k))) return null;
  }
  const added = Object.keys(later).filter((k) => !(k in earlier) && later[k] !== undefined && later[k] !== null && later[k] !== '');
  if (!added.length) return null;
  if (added.every((k) => CURSOR_ARGS.test(k))) return null;
  return added;
}

/**
 * Is `later` a contradiction of any call in `history`? Most recent first, so
 * the nearest earlier call wins when several qualify.
 */
export function detect(history: CallSummary[], later: CallSummary): Contradiction | null {
  if (later.items === null || later.items === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const earlier = history[i];
    if (earlier.items === null) continue;
    const added = addedBy(earlier.args, later.args, earlier.items === 0);
    if (!added) continue;
    if (earlier.items === 0) return { kind: 'empty-then-nonempty', earlier, later, added };
    if (!earlier.continuation && later.items > earlier.items) return { kind: 'more-with-superset', earlier, later, added };
  }
  return null;
}
