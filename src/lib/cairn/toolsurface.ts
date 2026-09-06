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
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function shapeOf(tool: Tool): ToolShape {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return {
    name: tool.name,
    description: tool.description ?? '',
    annotations: (tool.annotations as Annotations | undefined) ?? null,
    properties: props ? Object.keys(props).sort() : [],
    schemaHash: createHash('sha256').update(canonical(tool.inputSchema ?? {})).digest('hex'),
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
};
export function foldName(name: string): string {
  return name.normalize('NFKC').replace(/[\p{Cf}\p{Mn}]/gu, '').replace(/[Ͱ-ϿЀ-ӿ]/g, (c) => NAME_CONFUSABLES[c] ?? c);
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
  const tokens = nameTokens(foldName(name)).map((t) => t.toLowerCase());
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
  const paired = new Set<string>();
  for (const v of vanished) {
    const twin = appeared.find((a) => !paired.has(a.name) && a.schemaHash === v.schemaHash && a.description === v.description && annot(a.annotations) === annot(v.annotations));
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
