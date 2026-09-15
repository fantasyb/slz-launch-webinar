/**
 * End-of-task auto-write: the gateway records a finding by itself, from
 * evidence it collected during a session, when the task ends — and only
 * when the operator turned that on for this corpus.
 *
 * THE FLAG. `CAIRN_AUTOWRITE=1` in the gateway's environment. Anything else,
 * including unset, is OFF: the gateway collects the same evidence, writes the
 * same drafts under drafts/, and writes NOTHING to cairn/. `cairn:install`
 * never sets it unless asked (`--autowrite`), so a cold install has no
 * unattended corpus writer. The product owner authorised the gateway to
 * author findings on this one path, behind this flag, with this gate; the
 * gateway's own cairn_record tool is unchanged and no other path writes.
 *
 * WHAT PASSES. Two shapes, both success-shaped lies a person would otherwise
 * have to notice by hand:
 *   contradiction   the same tool answered a call and then a strict superset
 *                   of its arguments answered with more, while the first
 *                   result said nothing about being partial (contradiction.ts:
 *                   empty-then-nonempty, more-with-superset) — a default that
 *                   silently scoped, capped or missed;
 *   lie-shape       one successful result whose content matches a known lie:
 *                   an empty success that declares itself incomplete
 *                   (cairn-0052's shape), or content labelled base64 that is
 *                   already decoded text (cairn-0053's shape).
 *
 * WHAT IS REFUSED, always, however it was armed:
 *   transient       a failure that then succeeded because the failure was an
 *                   outage — 5xx, timeouts, resets, rate limits, and the whole
 *                   thrown-transport class the gateway arms as a hole. An
 *                   outage that clears is not a trap. This is the poison path
 *                   and it is excluded by pattern, before any other rule.
 *   fishing         a not-found that a different path/owner/repo/id resolved:
 *                   the caller was looking in the wrong place.
 *   input error     any other fail-then-succeed with changed arguments. It is
 *                   as likely the caller's own mistake as a trap, and a
 *                   machine cannot tell which; not written.
 *   duplicate       the corpus already has an active finding on this tool for
 *                   this shape.
 * So a plain fail-then-succeed arc NEVER auto-writes. It is still collected
 * (a draft under drafts/, for a person), and it is still refused here.
 *
 * PROVENANCE of what is written: by the gateway (`cairn-gateway`), through
 * recordSubmission with origin 'agent' — so agentRecorded, private, unsigned,
 * born aging, environment-specific, never operator-promoted, its check never
 * executed. Every field is machine-filled from the pair and defanged; nothing
 * is left blank for a person to complete, and no person is asked.
 */
import crypto from 'crypto';
import { defangUpstream, clip } from './defang';
import type { Finding } from './schema';

export const AUTOWRITE_ENV = 'CAIRN_AUTOWRITE';

/** ON only when the variable is exactly "1". Unset, empty, "0", "true": OFF. */
export function autowriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[AUTOWRITE_ENV] === '1';
}

export type LieShape = 'empty-incomplete' | 'base64-decoded';
export interface Call { args: Record<string, unknown>; output: string }

export type PendingArc =
  | { kind: 'recovered'; key: string; tool: string; at: string; failing: Call; working: Call; differed: string[]; done?: boolean }
  | { kind: 'contradiction'; key: string; tool: string; at: string; shape: 'empty-then-nonempty' | 'more-with-superset'; earlier: Call & { items: number }; later: Call & { items: number }; added: string[]; done?: boolean }
  | { kind: 'lie-shape'; key: string; tool: string; at: string; shape: LieShape; call: Call; done?: boolean };

/** A stable id for an arc, so a flush never writes the same one twice — within a session or across restarts (the ledger keeps the keys written). */
export function arcKey(tool: string, kind: string, ...parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify([tool, kind, ...parts])).digest('hex').slice(0, 16);
}

/* ---- lie shapes, read off one successful result ------------------------ */

function objectsIn(text: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  const push = (v: unknown) => { if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>); };
  push(parsed);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) for (const v of Object.values(parsed as Record<string, unknown>)) push(v);
  return out;
}

/** Base64 alphabet, and the decoded bytes read as text: real base64 of a text file, not a label on decoded text. */
function isBase64Text(s: string): boolean {
  const compact = s.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) return false;
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  if (!decoded) return false;
  const printable = decoded.replace(/[\x09\x0a\x0d\x20-\x7e -￿]/g, '').length;
  return printable / decoded.length < 0.05;
}

export function lieShape(text: string): LieShape | null {
  for (const o of objectsIn(text)) {
    /* cairn-0052's shape: a successful, empty result that says it is not complete. */
    const items = Array.isArray(o.items) ? o.items.length : null;
    const total = typeof o.total_count === 'number' ? o.total_count : null;
    if (o.incomplete_results === true && (items === 0 || total === 0) && (items ?? 0) === 0 && (total ?? 0) === 0) return 'empty-incomplete';
    /* cairn-0053's shape: encoding says base64, content is already text. */
    if (o.encoding === 'base64' && typeof o.content === 'string' && o.content.trim().length > 0 && !isBase64Text(o.content)) return 'base64-decoded';
  }
  return null;
}

/* ---- the gate ----------------------------------------------------------- */

/*
 * Transient or outage: the failure text says the service was not there, was
 * slow, was rate-limited, or the transport broke — including the gateway's own
 * wording for a thrown call and for an upstream that would not restart. An
 * outage that clears is not a trap.
 */
const TRANSIENT = /\b(5\d\d|timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|connection (closed|reset|refused|lost)|socket hang up|rate[ -]?limit\w*|429|too many requests|(temporarily |service )?unavailable|overloaded|try again later|not running|did not restart|transport failure|Streamable HTTP error|MCP error -32000|Connection closed|gateway timeout|bad gateway|internal server error)\b/i;
const THROWN_PREFIX = /^cairn-proxy: (call to .* failed|upstream .* is not running)/;
const NOT_FOUND = /\b(not found|404|no such|does not exist|doesn'?t exist|unknown (path|file|repo|repository|object|id)|ENOENT|no (matching )?(record|file|entry|item)s?)\b/i;
/** Arguments that say WHERE to look. A failure that changed only these was looking in the wrong place. */
const WHERE_KEYS = /^(path|paths?|owner|org|repo|repository|ref|branch|sha|commit|file|filename|dir|directory|name|id|ids|key|url|uri|object|table|collection|bucket|index|namespace|project|workspace)$/i;

const SHAPE_WORDS: Record<LieShape, string[]> = {
  'empty-incomplete': ['incomplete_results', 'incomplete'],
  'base64-decoded': ['base64'],
};

export interface Verdict { verdict: 'pass' | 'reject'; reason: string }

function namesTool(f: Finding, tool: string): boolean {
  const t = tool.toLowerCase();
  const short = t.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
  return (f.triggers ?? []).some((x) => { const y = x.trim().toLowerCase(); return y === t || y === short || y.endsWith(`__${short}`); });
}

export function gate(arc: PendingArc, corpus: Finding[]): Verdict {
  const active = corpus.filter((f) => f.status === 'active');
  if (arc.kind === 'recovered') {
    const out = arc.failing.output;
    /*
     * Fishing is decided FIRST. A not-found that the gateway itself wrapped
     * ("cairn-proxy: call to … failed: … Not Found") also matches the thrown
     * prefix, and on the crew's live corpus a wrong-path arc was logged as
     * transient for that reason. Both reject; the reason is what a person
     * reads in the ledger, so it names the shape that actually happened. A
     * true transient has no where-key change (usually no change at all) and
     * still lands on the transient branch.
     */
    if (NOT_FOUND.test(out) && arc.differed.length > 0 && arc.differed.every((k) => WHERE_KEYS.test(k))) return { verdict: 'reject', reason: `fishing: a not-found that a different ${arc.differed.join('/')} resolved` };
    if (THROWN_PREFIX.test(out) || TRANSIENT.test(out)) return { verdict: 'reject', reason: 'transient or outage: an outage that clears is not a trap' };
    return { verdict: 'reject', reason: 'a fail-then-succeed with changed arguments is as likely the caller\'s own input error as a trap; not auto-written' };
  }
  if (arc.kind === 'contradiction') {
    const dup = active.find((f) => namesTool(f, arc.tool) && ((f.tags ?? []).includes('shape:contradiction') || f.title.toLowerCase().includes(` without ${arc.added[0]}`.toLowerCase())));
    if (dup) return { verdict: 'reject', reason: `already recorded: ${dup.id}` };
    return { verdict: 'pass', reason: `${arc.shape}: the first result was silent about being partial` };
  }
  const words = SHAPE_WORDS[arc.shape];
  const dup = active.find((f) => namesTool(f, arc.tool) && ((f.tags ?? []).includes(`shape:${arc.shape}`) || words.some((w) => `${f.title} ${(f.tags ?? []).join(' ')}`.toLowerCase().includes(w))));
  if (dup) return { verdict: 'reject', reason: `already recorded: ${dup.id}` };
  return { verdict: 'pass', reason: `lie shape ${arc.shape} on a successful result` };
}

/* ---- machine fill ------------------------------------------------------- */

const cmd = (tool: string, args: Record<string, unknown>) => `${tool} ${clip(JSON.stringify(args), 2000)}`;

/*
 * URL and token shapes that ride in a contents-style result: a download_url
 * with a signed query (`?token=…`, SAS/S3 signatures), a bare `?token=` /
 * `&token=` parameter, and long blob/raw SHAs in a URL path. On the crew's
 * live corpus a genuine base64 lie-shape finding gate-passed and was then
 * REFUSED by the write path's secret scanner because the machine-filled
 * evidence carried exactly these. Scrubbed here, so the finding lands with no
 * token in it. Deliberately narrow: this is NOT the safety net. The write
 * path still scans the whole submission (recordSubmission → scanSensitive)
 * and refuses anything that survives — a secret in a result body, an opaque
 * blob in a field — so a secret never reaches cairn/. Both halves are pinned.
 */
const URL_QUERY = /(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/g;
const TOKEN_PARAM = /([?&](?:token|access_token|auth|key|api_key|apikey|sig|signature|X-Amz-[A-Za-z-]+|se|sv|sp|sr|st|sas)=)[^&\s"'<>]+/gi;
const SHA_IN_URL = /(https?:\/\/[^\s"'<>]*?\/)([0-9a-f]{32,})(?=[/?"'\s<>]|$)/gi;
/* A bare git object SHA (a `sha` field beside the URL). Not a secret — hex never
 * trips the scanner — but it identifies a private repo's blob and adds nothing
 * to a finding about the tool's behaviour. */
const BARE_SHA = /\b[0-9a-f]{40}\b/g;
export function scrubUrls(text: string): string {
  return text.replace(URL_QUERY, '$1?<redacted-query>').replace(TOKEN_PARAM, '$1<redacted>').replace(SHA_IN_URL, '$1<sha>').replace(BARE_SHA, '<sha>');
}
const out = (text: string) => clip(scrubUrls(defangUpstream(text)), 2000);
const bare = (tool: string) => tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');

/**
 * The submission, every field derived from the pair. Prose checks (marked
 * manual) because the trap lives behind a connector only whoever uses it can
 * re-run; the workaround is worded to be a real move, not a reflex the
 * write path refuses (no "retry", no "paginate" — recordFinding's DERIVABLE).
 */
export function fill(arc: PendingArc): Record<string, unknown> {
  const t = bare(arc.tool);
  const base = { tool: arc.tool, kind: 'trap', cost: 'minutes', scope: 'environment-specific' };
  if (arc.kind === 'lie-shape' && arc.shape === 'empty-incomplete') {
    return {
      ...base,
      title: `${t} returns an empty success with incomplete_results true`,
      claim: `${t} can return a successful result with zero items and incomplete_results true; reading only the item count concludes nothing matched, when the result itself declares that the search was not completed.`,
      expectation: 'A successful result with zero items means nothing matched the query.',
      reality: `The result was zero items with incomplete_results true — the service answered before it had finished looking. Observed: ${out(arc.call.output)}`,
      workaround: 'Treat zero items with incomplete_results true as no answer rather than as absence; confirm by a different route (fetch the thing directly, or narrow the query) before concluding it does not exist.',
      evidence: [{ command: cmd(arc.tool, arc.call.args), output: out(arc.call.output) }],
      check: { command: `Call ${t} with the same arguments; if it returns zero items with incomplete_results true while the thing exists by another route, the trap holds.`, confirmedIf: 'zero items and incomplete_results true, and the thing exists by another route', refutedIf: 'the items are returned, or incomplete_results is false, or the result carries an error instead of an empty success', manual: true },
      tags: ['autowrite', 'shape:empty-incomplete', 'incomplete_results'],
    };
  }
  if (arc.kind === 'lie-shape') {
    return {
      ...base,
      title: `${t} labels content base64 when it is already decoded text`,
      claim: `${t} returns encoding "base64" while content is already plain text; base64-decoding it as the label says corrupts a file that was fine as received.`,
      expectation: 'encoding "base64" means the content field must be base64-decoded before use.',
      reality: `The content was already readable text under a base64 label; decoding it yields garbage. Observed: ${out(arc.call.output)}`,
      workaround: 'Use content as text when it already parses as text; base64-decode only when the content is in the base64 alphabet and fails to read as text.',
      evidence: [{ command: cmd(arc.tool, arc.call.args), output: out(arc.call.output) }],
      check: { command: `Call ${t} on a known small text file; if encoding is base64 and content already reads as the file without decoding, the trap holds.`, confirmedIf: 'encoding is base64 and content reads as the file without decoding', refutedIf: 'content is real base64 (decoding yields the file) or the encoding field matches the bytes', manual: true },
      tags: ['autowrite', 'shape:base64-decoded', 'base64'],
    };
  }
  if (arc.kind === 'contradiction') {
    const added = arc.added.join(', ');
    const before = arc.earlier.items === 0 ? 'nothing' : `${arc.earlier.items} item(s) with nothing saying more existed`;
    return {
      ...base,
      title: `${t} returns ${arc.earlier.items === 0 ? 'nothing' : 'fewer items'} without ${added}, more with it`,
      claim: `${t} called without ${added} returned ${before}; the same call with ${added} returned ${arc.later.items} item(s). The default silently ${arc.earlier.items === 0 ? 'scoped the result to nothing' : 'capped the result'} and did not say so.`,
      expectation: 'A successful result that carries no continuation marker is the whole answer to the question asked.',
      reality: `Without ${added}: ${before}. With ${added}: ${arc.later.items} item(s). Observed first: ${out(arc.earlier.output)}`,
      workaround: `Pass ${added} explicitly on every call to ${t}; a result without it is not the whole set, whatever it says.`,
      evidence: [
        { command: cmd(arc.tool, arc.earlier.args), output: out(arc.earlier.output), note: `returned ${before}` },
        { command: cmd(arc.tool, arc.later.args), output: out(arc.later.output), note: `returned ${arc.later.items} item(s)` },
      ],
      check: { command: `Call ${t} without ${added} and note the count and whether it says more exists; then with ${added}. If the second returns more and the first did not say so, the trap holds.`, confirmedIf: 'the first call returns the smaller result with no indication that more exists, and the second returns more', refutedIf: 'the first call returns the same as the second, or says that more exists', manual: true },
      tags: ['autowrite', 'shape:contradiction', arc.shape],
    };
  }
  /* recovered: never written (gate), but a caller may want to see what would be. */
  return {
    ...base,
    title: `${t} failed and then succeeded with different arguments`,
    claim: `${t} failed once and succeeded on a later call whose arguments differed in ${arc.differed.join(', ') || 'nothing visible'}; the failure was not the caller's last word on the tool.`,
    expectation: 'The failing call was the tool refusing the request.',
    reality: `Failed: ${out(arc.failing.output)}. Then succeeded.`,
    workaround: `Compare the two calls' ${arc.differed.join(', ') || 'arguments'} before assuming the tool is broken.`,
    evidence: [{ command: cmd(arc.tool, arc.failing.args), output: out(arc.failing.output) }, { command: cmd(arc.tool, arc.working.args), output: '(succeeded)' }],
    check: { command: `Call ${t} with the failing arguments and confirm the error, then with the working ones and confirm success.`, confirmedIf: 'the first call fails as recorded and the second succeeds', refutedIf: 'the first call succeeds, or fails for an unrelated reason', manual: true },
    tags: ['autowrite', 'shape:recovered'],
  };
}
