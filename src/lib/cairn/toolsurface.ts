/**
 * A server's tool surface: what it offers, what each tool says about itself,
 * and what changed between two looks at it.
 *
 * Two consumers, one rule. The trial decides which tools an unattended model
 * may call and has to stop when the ground moves under a run. The gateway
 * sits in front of a real server all day and is the one component positioned
 * to notice the ground moving at all -- and a finding whose `triggers` name a
 * tool that was just renamed, or whose workaround describes an argument the
 * schema no longer has, is knowledge rotting at exactly that moment. So the
 * shape, the classification and the diff live here, once, and neither
 * consumer carries its own copy.
 *
 * Nothing in here resolves a corpus or touches disk: it is pure functions over
 * the SDK's Tool type, safe to import from a long-lived host (cairn-0046).
 */
import { createHash } from 'crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type Annotations = NonNullable<Tool['annotations']>;

/** What is worth comparing about a tool: its name, its declarations, its arguments, its description. */
export interface ToolShape {
  name: string;
  description: string;
  annotations: Annotations | null;
  /** Argument names, sorted. */
  properties: string[];
  /** Full sha256 over the canonical input schema, so a change in a nested type is seen without diffing JSON. Full width, not truncated: this hash gates a security decision (the trust pin), so a birthday collision must be infeasible, not merely unlikely. */
  schemaHash: string;
  /** The tool's display `title` — model-read prose, so a change post-approval is a rug-pull just like a description change. Optional in a pin written before it was covered. */
  title?: string;
  /** Full sha256 over the canonical OUTPUT schema. Also model-read (nested descriptions, enums), and unbounded, so it is pinned on the same footing as the input schema. Optional in an older pin. */
  outputSchemaHash?: string;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The hash of "no schema", so a pin written before outputSchema was covered
 * (field absent) compares equal to a live tool that has no output schema — only a
 * tool that actually HAS an output schema then needs a one-time re-approval. */
export const EMPTY_SCHEMA_HASH = createHash('sha256').update(canonical({})).digest('hex');

export function shapeOf(tool: Tool): ToolShape {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return {
    name: tool.name,
    description: tool.description ?? '',
    annotations: (tool.annotations as Annotations | undefined) ?? null,
    properties: props ? Object.keys(props).sort() : [],
    schemaHash: createHash('sha256').update(canonical(tool.inputSchema ?? {})).digest('hex'),
    title: (tool as { title?: string }).title ?? '',
    outputSchemaHash: createHash('sha256').update(canonical((tool as { outputSchema?: unknown }).outputSchema ?? {})).digest('hex'),
  };
}

/* ------------------------------------------------------------------------ */
/* Classification: may an unattended model call this?                        */
/* ------------------------------------------------------------------------ */

/**
 * The write verbs a tool name can carry. Matched against NAME TOKENS as a
 * prefix, never as a raw substring: a substring match reads "put" inside
 * `list_computers`, "eval" inside `data_retrieval`, "post" inside `compost`,
 * "charge" inside `surcharge` — flagging plain reads as writes. Tokenizing on
 * `_`/`-`/`.` and camelCase boundaries, then matching a verb only at the START
 * of a token, keeps the morphology tolerance that matters (`deployments` ->
 * `deploy`, `creates` -> `create`) while dropping the embedded-substring
 * false positives.
 */
const WRITE_VERBS = 'create|update|delete|upsert|execute|insert|remove|write|modify|destroy|drop|send|post|put|patch|deploy|run|shell|bash|exec|eval|sql|merge|push|approve|reject|transfer|grant|revoke|provision|terminate|restart|reboot|kill|scale|wipe|erase|format|truncate|refund|charge|email|invite|publish|unpublish|install|uninstall|rename|move|chmod|chown|edit|apply|commit|revert|rollback|reset|invoke|trigger|enable|disable|activate|deactivate|assign|unassign|import|upload|purge|flush|archive'
  // Added after Fable-5 flagged unannotated writes reaching a read-only role. The
  // leading-read-verb guard below keeps these from misreading a plain read
  // (list_orders, get_address, set-topped nouns) as a write.
  + '|add|set|save|submit|cancel|start|stop|close|open|resolve|mark|reply|comment|clear|restore|copy|clone|sync|launch|schedule|pause|resume|accept|complete|register|notify|dispatch|append|lock|unlock|regenerate|pay|order|book|make|generate';
// Fable-6: more high-value, low-collision action verbs. Kept OFF the prefix list
// are verbs that collide with a common read noun as a prefix (e.g. 'sign' would
// flag 'design'); those go in EXACT_WRITE below, matched as whole tokens only.
const WRITE_VERBS2 = `${WRITE_VERBS}|replace|migrate|checkout|login|logout|store|pull|click|navigate|sudo|kubectl|ssh|scp|rm|mv|cp|dd|mkfs|withdraw|deposit|checkin|redeem`;
const WRITE_TOKEN2 = new RegExp(`^(?:${WRITE_VERBS2})`, 'i');
// Whole-token write verbs — including collision-prone ones (sign, close, open,
// order, book, pay, add, set, mark) that must NOT be prefix-matched (they hide in
// design/closed/opener/orders/booking/payment/address/settings/marker). As an
// exact token they are unambiguous actions.
const EXACT_WRITE = new Set(`${WRITE_VERBS2}|sign|approve`.split('|'));
// A name whose FIRST token is one of these reads as a read whatever follows:
// list_orders, get_address, search_bookmarks are reads even though a later token
// prefix-collides with a write verb.
const READ_VERBS = /^(?:get|list|read|search|query|find|describe|fetch|show|view|count|check|status|lookup|scan|head|exists|inspect|preview|browse)$/i;
// A conjunction inside the name means it is a COMPOUND action, so a leading read
// verb no longer governs: get_or_create, find_and_replace, fetch_then_run.
const CONJUNCTION = /^(?:or|and|then|plus)$/i;
// Strip a leading re/un affix before verb matching so redeploy -> deploy,
// reinstall -> install, undelete -> delete are caught. Only re/un (not de, which
// collides: design -> sign), and only when a real verb remains.
const stripAffix = (t: string): string => t.replace(/^(?:re|un)(?=[a-z]{3})/i, '');
/** Split a tool name into word tokens on separators and camelCase boundaries. */
function nameTokens(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
}
// Fold a name so a look-alike or spaced-out write verb cannot evade the match:
// NFKC, drop format/combining chars, map the common Cyrillic/Greek confusables to
// Latin. `dеlete` (Cyrillic е) and `ｄｅｌｅｔｅ` (full-width) both fold to `delete`.
// Case is PRESERVED so camelCase tokenisation still works; callers lower-case
// per token. Used for both the write heuristic and denyTools matching.
const NAME_CONFUSABLES: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's', м: 'm', н: 'h', т: 't', к: 'k', в: 'b', д: 'd', г: 'r',
  ο: 'o', α: 'a', ε: 'e', ρ: 'p', υ: 'u', χ: 'x', κ: 'k', ν: 'v', ι: 'i', ϲ: 'c', τ: 't',
  // Final/lunate sigma, shha, palochka, dotless i, Armenian look-alikes.
  ς: 'c', һ: 'h', ӏ: 'l', ı: 'i', ո: 'n', ս: 'u', ա: 'a', օ: 'o', ց: 'g',
  // Non-decomposing extended-Latin letters (NFKD leaves these, unlike é/ñ/ü):
  // fold to their ASCII base so a legitimate name (größe, blåbær) stays a read
  // rather than tripping the residual-non-Latin fail-closed, AND a write verb
  // hidden with one (deløte) still resolves to the verb (Fable-7 follow-up to #14).
  ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ß: 'ss', þ: 'th', Þ: 'TH', ð: 'd', Ð: 'D', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', ħ: 'h', ĸ: 'k', ŋ: 'n', ſ: 's', å: 'a', Å: 'A',
  // Capitals fold to Latin CAPITALS so a leading look-alike letter still starts a
  // camelCase token (Дelete → Delete → delete), rather than lower-casing to a
  // non-Latin letter and slipping the write heuristic/denyTools match (Fable-6 #14).
  А: 'A', Е: 'E', О: 'O', Р: 'P', С: 'C', У: 'Y', Х: 'X', І: 'I', Ѕ: 'S', М: 'M', Н: 'H', Т: 'T', К: 'K', В: 'B', Д: 'D', Г: 'R',
  Ο: 'O', Α: 'A', Ε: 'E', Ρ: 'P', Υ: 'Y', Χ: 'X', Κ: 'K', Ν: 'N', Ι: 'I', Ϲ: 'C', Τ: 'T', Β: 'B', Η: 'H', Μ: 'M', Һ: 'H', Ӏ: 'L',
};
export function foldName(name: string): string {
  // NFKD (compatibility DECOMPOSITION) so a precomposed accented Latin letter
  // splits into base + combining mark; stripping the marks then leaves plain ASCII
  // (é→e, ñ→n, ü→u). This keeps a legitimately accented read name (get_données) an
  // ASCII read instead of tripping the residual-non-Latin fail-closed in
  // readsAsWrite, while a genuine non-Latin script (Cyrillic, Greek, Armenian) has
  // no ASCII decomposition and still folds via the table or fails closed.
  return name.normalize('NFKD').replace(/[\p{Cf}\p{Mn}]/gu, '').replace(/[À-ɏͰ-ϿЀ-ӿ԰-֏]/g, (c) => NAME_CONFUSABLES[c] ?? c);
}
/**
 * Does this name read as a write? Folded first (so a look-alike verb cannot
 * evade). A write token (prefix-matched, re/un affix stripped) makes it a write,
 * UNLESS the name is a SIMPLE read — a leading read verb, no conjunction, and no
 * later token that is EXACTLY a write verb. So list_orders/get_address stay reads,
 * while get_or_create (conjunction), read_write_file and fetch_and_sign (an exact
 * later write verb) are writes.
 */
export function readsAsWrite(name: string): boolean {
  const folded = foldName(name);
  // FAIL CLOSED on a residual non-Latin LETTER. The confusable table catches the
  // look-alikes we know, but a letter from an un-tabled script (Armenian ո, a
  // palochka ӏ, a dotless ı, a lunate sigma ϲ) survives folding and then acts as a
  // TOKEN SEPARATOR in nameTokens — splitting a verb (`deӏete` → de|ete) so its
  // prefix never matches. Rather than chase every script, treat any name that still
  // carries a non-ASCII letter after folding as a write. This makes the table an
  // accuracy aid, not the security boundary (Fable-6 #14 follow-up). The effect is
  // strict: a read-only role (enterprise authorize) denies on this alone, and
  // classify() flags it even under a readOnlyHint (the "both facts, a person
  // decides" rule) — so a tool with a genuinely non-Latin name that NFKD cannot
  // reduce to ASCII needs an explicit allow (a readOnlyStrict exception, or an
  // override) to be callable by a read-only principal. Accented Latin (é, ñ, ü) is
  // NOT caught: foldName's NFKD strips the diacritic to base ASCII first.
  if (/[^\x00-\x7f]/.test(folded.replace(/[^\p{L}]/gu, ''))) return true;
  const tokens = nameTokens(folded).map((t) => t.toLowerCase());
  if (!tokens.length) return false;
  const isWrite = (t: string) => WRITE_TOKEN2.test(t) || WRITE_TOKEN2.test(stripAffix(t)) || EXACT_WRITE.has(t) || EXACT_WRITE.has(stripAffix(t));
  if (!tokens.some(isWrite)) return false;
  const laterExactWrite = tokens.slice(1).some((t) => EXACT_WRITE.has(t) || EXACT_WRITE.has(stripAffix(t)));
  const simpleRead = READ_VERBS.test(tokens[0]) && !tokens.some((t) => CONJUNCTION.test(t)) && !laterExactWrite;
  return !simpleRead;
}
/** @deprecated Substring-matches; use readsAsWrite. Kept for callers that test raw names. */
export const WRITE_LOOKING = new RegExp(WRITE_VERBS, 'i');

export interface Classification {
  permitted: boolean;
  /** One line a person reads: where the decision came from. */
  reason: string;
  /** Set when an override in `readOnlyDespiteName` overruled an exclusion. */
  overridden?: string;
}

/**
 * The server's own statement first, the name only when it says nothing.
 *
 * `readOnlyHint: true` is the protocol's way of answering exactly this
 * question, so it is honoured -- except where the name reads as a write,
 * where trusting the declaration alone would be looser than the name rule
 * that preceded it; both facts are shown and a person decides.
 * `destructiveHint: true` or `readOnlyHint: false` is the server saying the
 * opposite, and a read-looking name does not rescue it. A tool with no
 * annotation is judged by its name, which is a guess, and the reason says so.
 */
export function classify(
  tool: { name: string; annotations?: Annotations | null },
  opts: { allowed?: string[]; overrides?: Record<string, string> } = {},
): Classification {
  const a = tool.annotations ?? null;
  const override = opts.overrides?.[tool.name];
  const excluded = (reason: string): Classification =>
    override ? { permitted: true, reason: `${reason}; overruled in readOnlyDespiteName`, overridden: override } : { permitted: false, reason };
  if (opts.allowed && !opts.allowed.includes(tool.name)) return { permitted: false, reason: 'not in allowedTools' };
  if (a?.readOnlyHint === true) {
    if (readsAsWrite(tool.name)) return excluded('declared read-only (readOnlyHint: true), but the name reads as a write');
    return { permitted: true, reason: 'declared read-only (readOnlyHint: true)' };
  }
  if (a?.destructiveHint === true) return excluded('declared destructive (destructiveHint: true)');
  if (a?.readOnlyHint === false) return excluded('declared not read-only (readOnlyHint: false)');
  if (readsAsWrite(tool.name)) return excluded('no annotation; name reads as a write');
  return { permitted: true, reason: 'no annotation; name reads as a read' };
}

/* ------------------------------------------------------------------------ */
/* Diff: what moved between two looks                                        */
/* ------------------------------------------------------------------------ */

export type ChangeKind = 'appeared' | 'vanished' | 'renamed' | 'annotations' | 'schema' | 'description';

export interface SurfaceChange {
  kind: ChangeKind;
  /** The tool as it was known before (for `appeared`, the new name). */
  tool: string;
  /** For `renamed`: the new name. */
  to?: string;
  /** One line a person reads. */
  detail: string;
}

const annot = (a: Annotations | null) => (a && Object.keys(a).length ? JSON.stringify(a) : 'none');

/**
 * A vanished tool and an appeared one with the same schema, description AND
 * annotations is a rename, and is reported as one rather than as a loss and a
 * gain: a finding whose trigger names the old name is exactly as valid, under
 * the new one, as it was -- which is the thing worth knowing.
 *
 * Annotations must match for the pairing, not only schema and description: a
 * read-only tool that reappears under a new name with `readOnlyHint` flipped to
 * a write is a privilege change, not a rename, and must surface as an `appeared`
 * (which the trust layer blocks) rather than hide inside a benign-looking
 * rename. The pairing is deliberately strict — a false "these are two different
 * tools" is safe; a false "this is just a rename" is a hole.
 */
export function diffSurface(before: ToolShape[], after: ToolShape[]): SurfaceChange[] {
  const was = new Map(before.map((t) => [t.name, t]));
  const now = new Map(after.map((t) => [t.name, t]));
  const out: SurfaceChange[] = [];
  const vanished = before.filter((t) => !now.has(t.name));
  const appeared = after.filter((t) => !was.has(t.name));
  // Missing pin fields (a pin written before title/outputSchema were covered)
  // read as their empty-equivalent, so an old pin does not false-alarm on a tool
  // that has no title / no output schema — only one that actually has them.
  const titleOf = (s: ToolShape) => s.title ?? '';
  const outHashOf = (s: ToolShape) => s.outputSchemaHash ?? EMPTY_SCHEMA_HASH;
  const paired = new Set<string>();
  for (const v of vanished) {
    // A rename must match the FULL model-read surface — schema, description,
    // annotations, AND title + output schema — or a rug-pull could relabel a tool
    // AND change its title/output prose while hiding as a clean rename.
    const twin = appeared.find((a) => !paired.has(a.name) && a.schemaHash === v.schemaHash && a.description === v.description && annot(a.annotations) === annot(v.annotations) && titleOf(a) === titleOf(v) && outHashOf(a) === outHashOf(v));
    if (twin) {
      paired.add(twin.name);
      out.push({ kind: 'renamed', tool: v.name, to: twin.name, detail: `${v.name} → ${twin.name} (same schema and description)` });
    } else {
      out.push({ kind: 'vanished', tool: v.name, detail: `${v.name} is no longer offered` });
    }
  }
  for (const a of appeared) {
    if (paired.has(a.name)) continue;
    out.push({ kind: 'appeared', tool: a.name, detail: `${a.name} appeared (${classify(a).reason})` });
  }
  for (const t of after) {
    const b = was.get(t.name);
    if (!b) continue;
    if (annot(b.annotations) !== annot(t.annotations)) {
      out.push({ kind: 'annotations', tool: t.name, detail: `${t.name}: annotations ${annot(b.annotations)} → ${annot(t.annotations)}` });
    }
    if (b.schemaHash !== t.schemaHash) {
      const added = t.properties.filter((p) => !b.properties.includes(p));
      const removed = b.properties.filter((p) => !t.properties.includes(p));
      const what = [
        removed.length ? `argument${removed.length > 1 ? 's' : ''} ${removed.join(', ')} removed` : '',
        added.length ? `argument${added.length > 1 ? 's' : ''} ${added.join(', ')} added` : '',
      ].filter(Boolean).join('; ') || 'a type or constraint changed';
      out.push({ kind: 'schema', tool: t.name, detail: `${t.name}: input schema changed (${what})` });
    }
    if (b.description !== t.description) {
      out.push({ kind: 'description', tool: t.name, detail: `${t.name}: description changed` });
    }
    // title and outputSchema are model-read and were NOT pinned before — a change
    // in either is a post-approval rug-pull, reported under the same blocking
    // kinds as a description / input-schema change (red-team C1).
    if (titleOf(b) !== titleOf(t)) {
      out.push({ kind: 'description', tool: t.name, detail: `${t.name}: title changed` });
    }
    if (outHashOf(b) !== outHashOf(t)) {
      out.push({ kind: 'schema', tool: t.name, detail: `${t.name}: output schema changed` });
    }
  }
  return out;
}

/**
 * Whether a finding is about a tool, by any of the names the same tool goes
 * by: the wire name, the client's `mcp__<server>__<name>`, and the
 * `<name> <argument>` form. `server` may be omitted when unknown.
 */
export function findingNames(triggers: string[] | undefined, tool: string, server?: string): boolean {
  const names = new Set([tool.toLowerCase(), ...(server ? [`mcp__${server}__${tool}`.toLowerCase()] : [])]);
  return (triggers ?? []).some((t) => names.has(t.trim().toLowerCase().split(/\s+/)[0]));
}
