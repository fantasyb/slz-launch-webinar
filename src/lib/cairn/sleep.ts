/**
 * Sleep — consolidation, not capture. Harvest findings from a transcript the
 * agent already produced, offline, with nobody having decided to write.
 *
 * THE REFRAME. The write problem was never a writing problem. The instant an
 * agent hits a trap, its own reasoning trace already says, in words, what it
 * expected, what happened, and — a beat later — why it was wrong. The finding
 * is already written; it just has to be harvested. Asking the busy agent to
 * ALSO author it, mid-task, in a rigorous format, is the tax that makes people
 * (and models) not do it. So we don't. We read the trace afterwards.
 *
 * THE BRAIN DOES EXACTLY THIS. Experience lands in a fast lossy buffer (the
 * transcript). Surprising moments carry a prediction-error tag AT the time (the
 * agent's own "oh, that's not what I expected" — already in the text). Then,
 * during sleep, an offline pass replays the buffer, gated by surprise, and
 * consolidates the tagged episodes into durable memory — abstractively, episode
 * to rule. This module is that offline pass's eyes: it finds the surprise gaps.
 *
 * SURPRISE IS THE GATE, AND ERRORS ARE THE WRONG SIGNAL (cairn-0045). An error
 * alone scores below threshold on purpose: the expensive traps return success
 * with a believable payload. What clears the gate is a MODEL UPDATE — the agent
 * reasoning, after a result, that it was wrong — or an in-session CONTRADICTION,
 * the same tool with wider arguments returning materially more. Both are visible
 * only in replay, with the end of the story in hand, which is the one thing the
 * agent lacked in the moment.
 *
 * This module is pure: it turns a transcript into ranked candidates. It writes
 * nothing and decides nothing about the corpus. Consolidating a candidate into a
 * finding, and letting selection (checks, usage, decay) cull it, happens
 * downstream — candidates are born provisional, in drafts/, never in cairn/.
 *
 * KNOWN LIMITS — what this recall deliberately does NOT reach, so nobody reads
 * silence as coverage (Fable review, R7/R11/P2/P4):
 *   - Recall is bounded by what the agent said to the HUMAN. On-disk `thinking`
 *     blocks are redacted to a signature, so the "reasoning trace" the reframe
 *     leans on survives only as user-facing prose; a quiet or headless run leaves
 *     less to harvest. The structural contradiction signals (superset, wrong-
 *     scope) are the prose-free floor that still fires when the agent said nothing.
 *   - A trap that neither the agent NOR the user noticed has no textual tell and
 *     is not recoverable here — accepted. Success-shaped wrong data with no tell
 *     (a right-looking count that is wrong) is prose-only for the same reason.
 *   - Cross-SESSION traps (empty in one session, wide in the next) and TWO-TOOL
 *     traps (curl-vs-browser; a search that says 0 for a symbol another call
 *     proves exists) have no structural path — priorEmpty is per-transcript,
 *     per-tool. They surface only when the agent wrote prose about them.
 *   - Bash harvests the agent's OWN inline scripts (heredocs, `node -e`) the same
 *     as an external program — nothing at this layer distinguishes them, and
 *     filtering the script forms would also drop real probes (a `python3 -c`
 *     import error is a genuine env trap). The check-writer's brief is the cull.
 *   - Dedup is per-candidate (by content hash), not per-TRAP: three probes of one
 *     trap become three drafts. The cheap gate and check-writer absorb the
 *     duplication; the corpus does not (a finding is recorded once).
 */

/** One normalized step in a session: text the agent said, or a tool round-trip. */
export interface Turn {
  role: 'user' | 'assistant';
  /** Assistant prose, or the user's words. */
  text?: string;
  /** Present when this turn is a tool call the agent made. */
  tool?: { name: string; input: Record<string, unknown> };
  /** Present on the paired result, merged onto the call turn. */
  result?: { text: string; isError: boolean };
}

interface RawBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof (c as RawBlock)?.text === 'string' ? (c as RawBlock).text : ''))
      .join('');
  }
  return '';
}

/**
 * Parse a Claude Code JSONL transcript into an ordered turn stream, pairing each
 * tool call with its result by id. Malformed lines are skipped, never fatal — a
 * transcript is an artefact we read, not one we control.
 */
export function parseTranscript(raw: string): Turn[] {
  const calls: Array<{ turn: Turn; id: string }> = [];
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // A line that is null/a number/a string parses fine, then `.message` on it
    // throws — and "malformed lines are skipped, never fatal" was the promise.
    if (!parsed || typeof parsed !== 'object') continue;
    const e = parsed as { message?: { role?: string; content?: unknown } };
    const m = e.message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = m.content;
    const blocks: RawBlock[] = Array.isArray(content)
      ? (content as RawBlock[])
      : [{ type: 'text', text: typeof content === 'string' ? content : '' }];

    for (const raw of blocks as unknown[]) {
      // A content array can hold null / a bare string; `b.type` on a non-object throws.
      if (typeof raw === 'string') { if (raw.trim()) turns.push({ role: m.role as 'user' | 'assistant', text: raw }); continue; }
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as RawBlock;
      if (b.type === 'tool_use' && b.name) {
        const turn: Turn = { role: 'assistant', tool: { name: b.name, input: (b.input ?? {}) as Record<string, unknown> } };
        turns.push(turn);
        if (b.id) calls.push({ turn, id: b.id });
      } else if (b.type === 'tool_result') {
        const paired = calls.find((c) => c.id === b.tool_use_id);
        const res = { text: blockText(b.content), isError: b.is_error === true };
        if (paired) paired.turn.result = res;
        else turns.push({ role: 'user', result: res });
      } else {
        const text = typeof b === 'string' ? b : b.text;
        if (typeof text === 'string' && text.trim()) turns.push({ role: (m.role as 'user' | 'assistant'), text });
      }
    }
  }
  return turns;
}

/* A model update — the agent, after a result, revising how it thought the tool
 * behaved. This is the prediction-error tag, in the agent's own words. Kept
 * conservative: a shrug ("yeah, obviously") is not an update; being wrong is. */
const UPDATE = [
  /\bactually\b/i,
  /\bturns? out\b/i,
  /\bit turns out\b/i,
  /\bnot what i (?:expected|thought)\b/i,
  /\bwrong (?:org|account|scope|environment|id|mapping)\b/i,
  /\bsilently\b/i,
  /\breturn(?:s|ed)? (?:zero|0|empty|nothing)\b/i,
  /\bno error\b/i,
  /\b(?:should|would) have\b/i,
  /\binstead of\b/i,
  /\bmisleading\b/i,
  /\bgotcha\b/i,
  /\bcapped?\b/i,
  /\bsurprising(?:ly)?\b/i,
  /\bi expected\b.*\bbut\b/i,
];
/* An expectation stated before the call — raises confidence the later result
 * was a genuine violation rather than a first look. */
const EXPECTATION = [/\bi expect\b/i, /\bshould (?:return|be|give|work|succeed)\b/i, /\bthis (?:will|should)\b/i, /\bto get\b/i];

const hits = (text: string, pats: RegExp[]): boolean => pats.some((p) => p.test(text));

export interface Candidate {
  tool: string;
  /** The agent's words before the call, if any — the expectation. */
  expectation: string;
  /** What the tool returned — the reality. */
  reality: string;
  /** The agent's words after the result — the model update / mechanism. */
  update: string;
  input: Record<string, unknown>;
  /** How strongly this cleared the surprise gate, and why. */
  surprisal: number;
  reasons: string[];
}

/*
 * ERRORS ARE BELOW THRESHOLD ALONE, ON PURPOSE. The scoring encodes cairn-0045:
 * an error the agent never reasoned about is the cheap class and scores 1, under
 * the bar. What clears it is a model update (3), a superset contradiction (2),
 * or an error the agent DID reason about (1 + 3). The gate admits the expensive
 * silent class and rejects the loud cheap one — the opposite of an error trigger.
 */
const THRESHOLD = 2;

/*
 * Is a parsed result payload empty? Anchored to the TOP LEVEL, which is the fix
 * for the old `:\s*\[\s*\]`-anywhere test: a non-empty payload whose rows each
 * carry an empty "labels":[] (GitHub) or "Tags":[] (Salesforce) is NOT empty,
 * and reading it as empty both poisoned the contradiction signal and missed the
 * genuinely-empty shapes below. Empty means: the whole payload is null / [] / {},
 * OR every top-level collection field is empty, OR every top-level count/total
 * is 0, OR data is null.
 */
const COLLECTION_KEY = /^(records?|items?|results?|rows?|data|values?|entries|matches|hits|edges|nodes|documents?|objects?|files?|events?|messages?|contents?)$/i;
const COUNT_KEY = /^(total|total_?count|count|size|num_?results|resultCount|totalSize)$/i;
export function jsonLooksEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return true;
  let sawSignal = false;
  for (const k of keys) {
    if (COLLECTION_KEY.test(k)) {
      sawSignal = true;
      const val = o[k];
      const emptyHere = val === null || val === undefined || (Array.isArray(val) && val.length === 0);
      if (!emptyHere) return false; // a non-empty collection field ⇒ not empty
    } else if (COUNT_KEY.test(k)) {
      sawSignal = true;
      if (typeof o[k] === 'number' && o[k] !== 0) return false; // a positive count ⇒ not empty
    }
  }
  // Every collection field was empty and every count was 0. If we saw either
  // kind of signal, call it empty; if the object had neither (an opaque record)
  // it is not an emptiness we can read.
  return sawSignal;
}

export function detectCandidates(turns: Turn[]): Candidate[] {
  const out: Candidate[] = [];

  /* For the contradiction signal: the last result seen per tool, by a stable key
   * of its arguments, so a later superset call with more rows can be spotted.
   *
   * Measured on a real coding transcript, this signal was a firehose: 18% of all
   * turns. The cause was applying "a superset of arguments returned more" to
   * SHELL tools, where the arguments are command/description/timeout, not query
   * filters — every longer command "supersets" a shorter one and every non-empty
   * output "contradicts" an empty one. So the signal is restricted to tools that
   * are not shell-shaped, and non-semantic keys (description, timeout, and the
   * like) are dropped from the arg-key, because adding a description is not
   * widening a query. The model-update signal still fires everywhere; only this
   * structural one is scoped, because only this one is meaningless off-query. */
  const SHELL = /^(bash|shell|sh|exec|run|terminal|command)$/i;
  /*
   * Harvest only EXTERNAL surfaces. The agent's own built-in tools — Read, Edit,
   * Glob, Grep, a sub-Agent, AskUserQuestion — are its hands, not a tool whose
   * behaviour is a trap worth banking for the next agent, and harvesting them
   * turned a coding session into a firehose (119 of 197 candidates on one real
   * transcript were Read/Edit scaffolding, because a Read of any file containing
   * "[]" read as "empty" and the next Read of it "superset"-contradicted it).
   * The external surface is an MCP server (mcp__*), a shelled-out program (Bash),
   * or the network (WebFetch/WebSearch). This is an ALLOWLIST, not a denylist of
   * known built-ins, on purpose: the harness grows a new built-in every release,
   * and a denylist under an "unknown is kept" policy re-opens the firehose on
   * each one. The cost is that a custom, bare-named external tool (not mcp__-
   * prefixed) is not harvested until it is added here — rare, and the loud
   * failure (it harvests nothing) beats the silent one (the firehose returns).
   */
  const EXTERNAL = (name: string): boolean =>
    /^mcp__/.test(name) || SHELL.test(name) || /^(WebFetch|WebSearch)$/i.test(name);
  /*
   * Claude Code's own permission-system, cancellation and input-validation
   * messages. A call these describe never reached the tool, so the text is the
   * harness talking, not the tool. Specific on purpose in BOTH directions: a
   * bare "permission denied" is a real shell trap (cf. cairn-0035) and must
   * still harvest, and an OAuth provider's own "the user has denied access" /
   * "Denied by user" is a genuine external-tool result, NOT this — those broad
   * phrasings were removed after they were found to swallow real auth traps.
   * The <tool_use_error> wrapper is NOT matched wholesale (it wraps genuine tool
   * errors too); only the specific harness-noise strings inside it are.
   */
  const HARNESS_DENIAL = /(the user doesn't want to proceed with this tool use|the tool use was rejected|Permission for this action was denied|denied by the Claude Code|Claude Code auto[- ]?monitor|requested permissions to use|InputValidationError|exceeds maximum allowed (?:size|tokens|length)|Blocked:[^\n]*\buse Monitor\b)/i;
  const NON_SEMANTIC = new Set(['description', 'timeout', 'run_in_background', 'reason', 'explanation']);
  /* Scope/context parameters: the ones whose WRONG VALUE is the trap (the MCP
   * bound to the sandbox org, the query against the wrong branch/ref/env). A
   * later call that changes only one of these and flips empty -> rows is the
   * wrong-scope trap, even though the argument KEYS are identical — which the
   * superset signal (more keys) misses entirely. */
  const SCOPE_KEYS = /^(org|orgId|org_id|branch|ref|revision|environment|env|stage|mapping|mappingId|mapping_id|database|db|project|projectId|project_id|account|accountId|tenant|workspace|region|zone|instance|namespace|catalog|schema|host|realm)$/i;
  const isSemantic = (k: string) => !NON_SEMANTIC.has(k);
  /* Keys only, for the superset signal (a wider QUERY returns more). */
  const argKey = (input: Record<string, unknown>) => Object.keys(input).filter(isSemantic).sort().join(',');
  /* key=value of the non-scope args ("what am I asking") and of the scope args
   * ("where"), so the same question under a different scope can be spotted. */
  const semanticSig = (input: Record<string, unknown>) =>
    Object.keys(input).filter((k) => isSemantic(k) && !SCOPE_KEYS.test(k)).sort().map((k) => `${k}=${JSON.stringify(input[k])}`).join('&');
  const scopeSig = (input: Record<string, unknown>) =>
    Object.keys(input).filter((k) => isSemantic(k) && SCOPE_KEYS.test(k)).sort().map((k) => `${k}=${JSON.stringify(input[k])}`).join('&');
  const looksEmpty = (text: string): boolean => {
    const s = text.trim();
    if (s === '') return true;
    try {
      return jsonLooksEmpty(JSON.parse(s));
    } catch {
      /* not JSON — fall through to the textual empty shapes */
    }
    return /^\s*(no (?:results?|matches|records?|rows?|items?|data|files?|events?)\b|not found|nothing (?:found|returned)|empty)\b/i.test(s)
      || /(^|\W)0 (?:results?|matches|records?|rows?|items?|files?|events?)\b/i.test(s);
  };

  const priorEmptyKeys = new Map<string, Set<string>>();               // tool -> argKeys that returned empty (superset signal)
  const priorEmptyScopes = new Map<string, Map<string, Set<string>>>(); // tool -> semanticSig -> scopeSigs seen empty (wrong-scope signal)

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.tool || !t.result) continue;
    // Harvest only external surfaces — see EXTERNAL. The agent's own built-in
    // file/search/task tools are its hands, never a bankable trap.
    if (!EXTERNAL(t.tool.name)) continue;
    // A call the harness denied, blocked, or rejected never reached the tool,
    // so its result is not the tool's behaviour — see HARNESS_DENIAL.
    if (HARNESS_DENIAL.test(t.result.text)) continue;

    const expectation = i > 0 && turns[i - 1].role === 'assistant' && turns[i - 1].text ? turns[i - 1].text! : '';
    /* The model update: the next prose that reads as a correction, from the
     * agent OR the user — a user's "no, that's the sandbox org, there are 40" is
     * the strongest surprise signal a transcript holds, and requiring role
     * 'assistant' threw it away. Scan to the next tool action, and prefer an
     * update-worded turn over the first scrap of narration ("Got 50. Summarising."
     * used to win the window and bury the correction two turns behind it). */
    let update = '';
    let firstText = '';
    for (let j = i + 1; j < Math.min(turns.length, i + 6); j++) {
      const tj = turns[j];
      if (tj.tool) break; // a new action ends this result's discussion
      if (tj.text && (tj.role === 'assistant' || tj.role === 'user')) {
        if (!firstText) firstText = tj.text;
        if (hits(tj.text, UPDATE)) { update = tj.text; break; }
      }
    }
    if (!update) update = firstText;

    /* Surprise requires something to be surprised BY. A model update counts only
     * when the result itself was notable — an error, an empty payload, or a
     * violated stated expectation. Free-floating "actually / turns out" after a
     * plain successful call is the agent narrating its own work, not its model of
     * a tool changing (measured: 652 of 704 candidates were commit narration
     * without this anchor). */
    const empty = looksEmpty(t.result.text);
    const expected = hits(expectation, EXPECTATION);
    const notable = t.result.isError || empty || expected;

    const reasons: string[] = [];
    let score = 0;
    if (notable && hits(update, UPDATE)) {
      score += 3;
      reasons.push('the agent revised its model of the tool after a notable result');
    }
    if (t.result.isError) {
      score += 1;
      reasons.push('the call errored');
    }
    /* No standalone bonus for a stated expectation: it gates the model-update
     * signal (via `notable`) but does not itself clear the bar. Adding it did —
     * a vague "let me try to get X" plus any error summed to THRESHOLD and
     * admitted exactly the cheap unreasoned-error class cairn-0045 rejects. */

    /* In-session contradiction — two shapes of the silent-scope / wrong-default
     * trap, both invisible in the moment and plain in replay:
     *   (a) a wider QUERY (more args) returns rows where a narrower one was empty;
     *   (b) the SAME query under a different SCOPE (org/branch/env) returns rows
     *       where one scope was empty — identical arg keys, different "where". */
    if (!t.result.isError && !SHELL.test(t.tool.name)) {
      const key = argKey(t.tool.input);
      const sem = semanticSig(t.tool.input);
      const scope = scopeSig(t.tool.input);
      if (empty) {
        (priorEmptyKeys.get(t.tool.name) ?? priorEmptyKeys.set(t.tool.name, new Set()).get(t.tool.name)!).add(key);
        const byScope = priorEmptyScopes.get(t.tool.name) ?? priorEmptyScopes.set(t.tool.name, new Map()).get(t.tool.name)!;
        (byScope.get(sem) ?? byScope.set(sem, new Set()).get(sem)!).add(scope);
      } else {
        const nowKeys = new Set(key ? key.split(',') : []);
        let fired = false;
        for (const prior of priorEmptyKeys.get(t.tool.name) ?? []) {
          const priorKeys = new Set(prior ? prior.split(',') : []);
          if ([...priorKeys].every((a) => nowKeys.has(a)) && nowKeys.size > priorKeys.size) {
            score += 2;
            reasons.push('an earlier call with fewer arguments returned empty; this superset returned rows');
            fired = true;
            break;
          }
        }
        if (!fired) {
          const scopes = priorEmptyScopes.get(t.tool.name)?.get(sem);
          if (scopes && [...scopes].some((s) => s !== scope)) {
            score += 2;
            reasons.push('the same query returned empty under a different scope (org/branch/env) and rows here — a wrong-scope trap');
          }
        }
      }
    }

    if (score >= THRESHOLD) {
      out.push({
        tool: t.tool.name,
        expectation: expectation.slice(0, 1000),
        reality: t.result.text.slice(0, 2000),
        update: update.slice(0, 1000),
        input: t.tool.input,
        surprisal: score,
        reasons,
      });
    }
  }

  return out.sort((a, b) => b.surprisal - a.surprisal);
}
