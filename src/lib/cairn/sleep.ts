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
    let e: { message?: { role?: string; content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e.message;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = m.content;
    const blocks: RawBlock[] = Array.isArray(content)
      ? (content as RawBlock[])
      : [{ type: 'text', text: typeof content === 'string' ? content : '' }];

    for (const b of blocks) {
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
  const NON_SEMANTIC = new Set(['description', 'timeout', 'run_in_background', 'reason', 'explanation']);
  const priorEmpty = new Map<string, Set<string>>(); // tool -> set of arg-key strings that returned "empty"
  const argKey = (input: Record<string, unknown>) =>
    Object.keys(input)
      .filter((k) => !NON_SEMANTIC.has(k))
      .sort()
      .join(',');
  const looksEmpty = (t: string) => /(:\s*\[\s*\]|"records"\s*:\s*\[\s*\]|\b0 (?:rows|records|results)\b|^\s*$)/i.test(t);

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.tool || !t.result) continue;

    const expectation = i > 0 && turns[i - 1].role === 'assistant' && turns[i - 1].text ? turns[i - 1].text! : '';
    /* The next assistant prose after the result is the model update. */
    let update = '';
    for (let j = i + 1; j < Math.min(turns.length, i + 4); j++) {
      if (turns[j].role === 'assistant' && turns[j].text) {
        update = turns[j].text!;
        break;
      }
    }

    const reasons: string[] = [];
    let score = 0;
    if (hits(update, UPDATE)) {
      score += 3;
      reasons.push('the agent revised its model of the tool after the result');
    }
    if (t.result.isError) {
      score += 1;
      reasons.push('the call errored');
    }
    if (hits(expectation, EXPECTATION)) {
      score += 1;
      reasons.push('the agent had stated an expectation before the call');
    }

    /* In-session contradiction: an empty success on some args, then a superset
     * of those args returning non-empty. The silent-scope / wrong-default trap,
     * invisible in the moment, plain in replay. */
    const key = argKey(t.tool.input);
    const empties = priorEmpty.get(t.tool.name);
    if (!t.result.isError && !SHELL.test(t.tool.name) && key) {
      if (looksEmpty(t.result.text)) {
        (priorEmpty.get(t.tool.name) ?? priorEmpty.set(t.tool.name, new Set()).get(t.tool.name)!).add(key);
      } else if (empties) {
        for (const prior of empties) {
          const priorArgs = new Set(prior ? prior.split(',') : []);
          const nowArgs = new Set(key ? key.split(',') : []);
          const superset = [...priorArgs].every((a) => nowArgs.has(a)) && nowArgs.size > priorArgs.size;
          if (superset) {
            score += 2;
            reasons.push('an earlier call with fewer arguments returned empty; this superset returned rows');
            break;
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
