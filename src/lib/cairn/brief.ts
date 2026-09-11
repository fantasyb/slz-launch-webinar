/**
 * brief — put the findings in front of the reader instead of behind a tool call.
 *
 * WHY THIS EXISTS
 *
 * Retrieval accuracy is an upper bound on what a corpus delivers, never a
 * lower one. Measured: on the one scenario where the corpus demonstrably
 * changes the outcome, claude-opus-5 scored 0/5 without it and 5/5 with it,
 * querying unprompted on its second tool call every time. claude-haiku-4-5 on
 * the identical task, with the identical tool and the identical description,
 * scored 0/5 in BOTH arms and issued zero queries across five trials. A
 * perfect index returns nothing to an agent that never asks. That is
 * cairn-0035.
 *
 * The corpus already had two delivery paths and a weak reader defeats both.
 * Pull retrieval needs the agent to ask. Preflight needs a command to match
 * against, so it covers traps you enter by RUNNING something and misses traps
 * you enter by WRITING something -- verified on the failing transcripts, where
 * preflight on the actual commands returns nothing known.
 *
 * This is the third path: assemble the relevant findings before the agent
 * starts and hand them over unasked.
 *
 * PRECISION, NOT RECALL, AND THE ASYMMETRY IS THE WHOLE DESIGN
 *
 * A tool call is opt-in, so a bad result costs the one agent that asked for
 * it. Injection is not: whatever goes in here is paid for by every task,
 * whether or not it is relevant, and an irrelevant trap in front of an agent
 * is worse than no trap at all -- it spends attention and teaches the reader
 * that this channel is noise. So the gate is deliberately tighter than search:
 * only matches the retriever labels 'strong', at most three, under a hard
 * character budget, and SILENCE IS THE COMMON CASE. Returning nothing is the
 * correct answer for most tasks and must stay cheap.
 */
import type { Finding } from './schema';
import { retrieve, tokenize, DISTINCTIVE_FLOOR, type Hit } from './retrieval';

export interface BriefOptions {
  /** Most findings to include. More than a few stops being read. */
  limit?: number;
  /**
   * Hard ceiling on the rendered block. A brief that competes with the task
   * for attention has already failed, whatever it contains.
   */
  maxChars?: number;
  /** Evaluate preconditions against this process's environment. */
  useLocalEnvironment?: boolean;
}

/*
 * MIN_EXPLAINED was measured, and re-measured when the quantity changed under
 * it. `explained` now counts only the terms a finding ATTESTS -- its own
 * account of itself, not the questions generated to guess how somebody might
 * ask -- so the old 0.5, calibrated against the undiscounted fraction, silenced
 * the brief entirely on a task it had been getting right.
 *
 * Re-swept against the same two populations: the held-out cases, each genuinely
 * about one finding, and 15 ordinary tasks in domains this corpus says nothing
 * about.
 *
 *   gate    gold delivered   false alarms
 *   0.15         81%              7%
 *   0.20         79%              7%
 *   0.25         78%              7%
 *   0.50         34%              7%
 *
 * The false-alarm rate is now FLAT across the range, which is the real result:
 * noise is being held out by the strong/weak label rather than by this
 * threshold, because attested coverage feeds the caveat that decides it. Under
 * the old measure the same 7% cost 59% of delivery. So this is set for recall
 * with one step of margin, and it is no longer the part carrying precision.
 */
const MIN_EXPLAINED = 0.2;
const DEFAULTS = { limit: 3, maxChars: 2400 } as const;

/**
 * How a matched finding is delivered.
 *
 *   full  the WHAT HAPPENS / INSTEAD block, spent unasked on every task.
 *   hint  a single line naming the trap and how to expand it.
 *
 * The tier is the finding's own `cost` — what rediscovering it from scratch
 * costs. Measured (records-opus gateway trial, frontier Opus): pushing the full
 * block at a trap the model recovers from cheaply on its own COSTS more than it
 * saves — the silent 50-cap (an expensive partition to work around) came in 25%
 * cheaper with the full block, but the stale-mapping trap (a quick list-and-retry)
 * came in 2x DEARER, because the block's overhead outweighed a discovery the
 * model would have made anyway. So a full push is reserved for traps that are
 * expensive to rediscover; a cheap one gets a hint the model can expand if it
 * judges the task needs it. The hint is the anti-blocking guarantee: nothing
 * relevant is ever withheld, only demoted from spent-unasked to one-call-away.
 */
export type Tier = 'full' | 'hint' | 'topical';

/** cost is 'minutes' | 'hours' | 'days'; only 'minutes' is cheap enough to demote. */
export function tierOf(cost: Finding['cost']): Tier {
  return cost === 'minutes' ? 'hint' : 'full';
}

/** One line per finding, in the order the retriever ranked them. */
export interface BriefEntry {
  id: string;
  title: string;
  reality: string;
  workaround?: string;
  /**
   * full = worth spending on every task; hint = named, expandable on request;
   * topical = the retriever labelled it weak, but it matched on several
   * distinctive terms of the task — named in one line, never the full block.
   */
  tier: Tier;
}

/**
 * WEAK BUT TOPICAL. The `strong` label flips to weak at two caveats
 * (retrieval.ts), and a task phrased as intent — "wiring an MCP tool with zod
 * schema validation" — earns exactly two on the finding it is about: it covers
 * only ~60% of the query, and it carries no error code, path or flag. Every
 * genuinely-unknown task the second external crew and the 15-domain sweep
 * tried carries a THIRD: it matched on one distinctive term, or on none. So the
 * retriever already separates "soft phrasing of a known trap" from "the corpus
 * has nothing", and the strong-only filter was discarding that separation —
 * the brief blanked on the same query `find` answered first.
 *
 * This is the rule the caveat is computed from, applied directly rather than
 * by matching its text: at least two matched terms that are informative in
 * this corpus AND not ordinary English — counted after folding plurals, since
 * "hooks" and "hook" are one term of the task, not two (a refactor-to-React-
 * hooks task fired on the per-invocation-hook finding through exactly that
 * gap). Plus the same coverage floor, an active finding, and a non-zero
 * confidence (a retired or contested finding is not something to nudge a
 * reader toward). Applied to the TOP-RANKED hit only: the one the reader
 * would have seen first from `find`, and the one the quiet-on-unknown suites
 * judge. One entry, one line, only when nothing strong was found — it never
 * adds to a strong brief and never renders the full block, so a wrong
 * topical line costs a reader one sentence.
 *
 * AND THE TERMS MUST CARRY REAL INFORMATION, TOGETHER. Two distinctive terms
 * was not enough: the third external crew got a topical nag on "Stripe
 * Checkout vs custom form" from an eval-vocabulary finding, because "vs" and
 * "form" each cleared the per-term floor (2.3 bits apiece, in a corpus that
 * rarely says either) while the whole hit scored 1.9. Ordinary English can
 * share two rare-ish tokens with a corpus this small; a real trap shares
 * terms that NARROW it. So the distinctive terms' information is summed and
 * must clear TOPICAL_INFORMATION. Measured on the cases that decided it:
 *
 *   "Stripe Checkout vs custom form"      -> cairn-0039   4.6   (false nag)
 *   "LinkedIn post kill-vs-ship"          -> cairn-0051   4.0   (false nag)
 *   proxy paraphrase, no proxy on the box -> cairn-0031   4.1   (false nag)
 *   "wiring MCP tool with zod schema..."  -> cairn-0043   6.3   (right)
 *   "MCP tool argument is undefined..."   -> cairn-0043   6.9   (right)
 *   "connection refused ... from the agent" -> cairn-0001 8.8   (right)
 *
 * 5.0 sits between the populations with the gap on the side of silence; the
 * per-term floor (DISTINCTIVE_FLOOR) still applies to each term counted.
 *
 * AND THE INFORMATION MUST LAND ON THE FINDING'S OWN ACCOUNT OF THE TRAP.
 * The sum was not enough either. The fourth crew got two more nags from
 * ordinary startup-speak, and this time a floor could not fix it:
 *
 *   "choosing between Stripe Checkout and a custom card form
 *    for a 5-day sprint deliverable"         -> cairn-0039   9.55  (false nag)
 *   "writing a LinkedIn Company Page post
 *    about kill vs ship for founders"        -> cairn-0014   6.22  (false nag)
 *   "connection refused reaching an external
 *    host from the agent"                    -> cairn-0001   6.85  (right)
 *   "wiring MCP tool with zod schema and the
 *    argument comes through undefined"       -> cairn-0043   6.19  (right)
 *
 * The false nag OUTSCORES both true topicals, so no value of the sum floor
 * separates them: raising it past 9.55 silences the MCP and proxy lines too.
 * Summing per-term rarity double-counts correlated ordinary English --
 * "choosing", "day" and "form" are each rare in a corpus that talks about
 * proxies and hooks, but they are jointly unremarkable in a task about a
 * sprint deliverable. What separates the populations is not how rare the
 * terms are but WHERE they landed. Every term the false nags matched sits in
 * the finding's WORKAROUND ("choosing", "form", "ship", "writing"): advice
 * prose, written in the imperative English that ordinary tasks are also
 * written in. Every term the true topicals matched sits in the finding's
 * record of the trap itself: its title, subject, claim, expectation and
 * reality ("zod", "mcp", "tool"; "host", "connection", "agent").
 *
 * So the distinctive information is split by which fields attest each term,
 * and the finding's own ACCOUNT -- what it is (title, subject), what it
 * asserts (claim) and what it recorded happening (expectation, reality) --
 * must carry MORE THAN HALF of it. Excluded: the workaround (prescription,
 * the collision surface above), mechanism and appliesTo (explanation, already
 * damped to the weak tier in retrieval.ts for the same reason), the check and
 * evidence (machine text, where "page" and "day" match by accident), tags
 * (labels, not a record: the ones that decide a case here, "zod" and "mcp",
 * are in the claim already, and the hyphenated ones, "connection-refused",
 * are single tokens a prose query never hits) and the generated questions (a
 * model's guess, not a record). Measured as the share of the distinctive sum
 * the account carries:
 *
 *   "choosing between Stripe Checkout ... deliverable"  -> cairn-0039   0.34  (silent)
 *   "writing a LinkedIn Company Page post ... founders"  -> cairn-0014   0.32  (silent)
 *   "connection refused reaching an external host ..."  -> cairn-0001   0.74  (topical)
 *   "connection refused when calling an external ..."   -> cairn-0001   0.80  (topical)
 *   "wiring MCP tool with zod schema ..."                -> cairn-0043   1.00  (topical)
 *   "MCP tool argument is undefined in the handler ..."  -> cairn-0043   1.00  (topical)
 *
 * The gap is 0.34 to 0.74 and "more than half" sits inside it with margin on
 * both sides. Strong hits never reach this rule: it decides only whether a
 * weak top hit earns its one line. The sum floor and the per-term floor stay
 * as they were, so nothing that was silent before speaks now.
 */
const TOPICAL_INFORMATION = 5.0;
const ACCOUNT_SHARE = 0.5;
const fold = (term: string): string => term.toLowerCase().replace(/(ies|sses|xes|ches|shes|s)$/, (m) => (m === 'ies' ? 'y' : m === 's' ? '' : m.slice(0, -2)));

/*
 * The tokens of a finding's own account of the trap, tokenised the same way the
 * postings are so a matched term's membership is a like-for-like test.
 * Memoised per finding object; the corpus is reloaded as new objects, so a
 * WeakMap follows it without a cache to invalidate.
 */
const accountMemo = new WeakMap<Finding, Set<string>>();
function accountTokens(f: Finding): Set<string> {
  let set = accountMemo.get(f);
  if (!set) {
    set = new Set(
      tokenize([f.title, f.subject.name, f.subject.ecosystem, f.claim, f.expectation, f.reality].join('\n')).map(
        (t) => t.text,
      ),
    );
    accountMemo.set(f, set);
  }
  return set;
}

function weakButTopical(h: Hit): boolean {
  if (h.strength === 'strong') return false;
  if (h.explained < MIN_EXPLAINED) return false;
  if (h.finding.status === 'retired' || h.confidence <= 0) return false;
  /* One entry per folded term, keeping the most informative spelling, so "hooks"/"hook" is counted once. */
  const distinctive = new Map<string, { information: number; onAccount: boolean }>();
  const account = accountTokens(h.finding);
  for (const m of h.matched) {
    if (m.common || m.anchorInformation < DISTINCTIVE_FLOOR) continue;
    const k = fold(m.term);
    const prev = distinctive.get(k);
    if (!prev || m.anchorInformation > prev.information) {
      distinctive.set(k, { information: m.anchorInformation, onAccount: account.has(m.term) });
    }
  }
  if (distinctive.size < 2) return false;
  let information = 0;
  let onAccount = 0;
  for (const v of distinctive.values()) {
    information += v.information;
    if (v.onAccount) onAccount += v.information;
  }
  if (information < TOPICAL_INFORMATION) return false;
  return onAccount > information * ACCOUNT_SHARE;
}

function entryOf(h: Hit, tier: Tier): BriefEntry {
  return {
    /*
     * The namespaced id for an upstream finding. The brief is read by an
     * agent that may then cite the id back, and on a corpus subscribed to
     * an upstream "cairn-0001" names two different claims.
     */
    id: (h.finding as { displayId?: string }).displayId ?? h.finding.id,
    title: h.finding.title,
    reality: h.finding.reality,
    ...(h.finding.workaround ? { workaround: h.finding.workaround } : {}),
    tier,
  };
}

/**
 * The findings worth handing over unasked for this task, strongest first.
 *
 * Empty for most tasks. That is the intended behaviour, not a failure to
 * match: see the precision note above.
 */
export function briefEntries(task: string, corpus: Finding[], opts: BriefOptions = {}): BriefEntry[] {
  const limit = opts.limit ?? DEFAULTS.limit;
  if (!task.trim() || corpus.length === 0) return [];
  const hits = retrieve(task, corpus, {
    useLocalEnvironment: opts.useLocalEnvironment,
    limit: Math.max(limit * 3, 9),
  });
  /*
   * The retriever's own weak/strong label rather than a score threshold: it
   * already accounts for whether the terms that matched were ordinary
   * English, and rebuilding that judgement from a raw score here would be a
   * second, worse copy of it. The label alone is calibrated for a reader who
   * asked, though, so injection adds the coverage floor above.
   */
  const strong = hits
    .filter((h) => h.strength === 'strong' && h.explained >= MIN_EXPLAINED)
    .slice(0, limit)
    .map((h) => entryOf(h, tierOf(h.finding.cost)));
  if (strong.length) return strong;
  /* Nothing strong: at most ONE weak-but-topical line, and only if the TOP-RANKED hit earns it. */
  const top = hits[0];
  return top && weakButTopical(top) ? [entryOf(top, 'topical')] : [];
}

/**
 * The brief as text, ready to prepend to a system prompt. Empty when there is
 * nothing worth saying, which is most of the time.
 */
export function brief(task: string, corpus: Finding[], opts: BriefOptions = {}): string {
  return renderBrief(briefEntries(task, corpus, opts), opts.maxChars ?? DEFAULTS.maxChars);
}

/**
 * Render already-selected entries to the text block, each within a shared
 * character budget and dropped whole rather than truncated. Separated from
 * retrieval so the delivery tiers can be exercised without the retriever's
 * corpus-relative scoring in the way.
 */
export function renderBrief(entries: BriefEntry[], budget: number = DEFAULTS.maxChars): string {
  if (!entries.length) return '';

  const head =
    'Before you start: someone has already hit the following in this codebase or on this ' +
    'machine, and recorded it. These were retrieved by matching your task, so judge whether ' +
    'each one actually applies — a match is not a verdict.\n';

  const lines: string[] = [head];
  let used = head.length;
  for (const e of entries) {
    /*
     * Trimmed per entry rather than truncating the whole block, so a long
     * first finding cannot silently swallow the two behind it. A hint is a
     * single line: the trap named, and the one call that expands it, so the
     * reader spends a line here and the full account only if it chooses to.
     */
    const block =
      e.tier === 'full'
        ? `\n${e.id} — ${e.title}\n  WHAT HAPPENS: ${clip(e.reality, 420)}` +
          (e.workaround ? `\n  INSTEAD: ${clip(e.workaround, 420)}` : '') +
          '\n'
        : e.tier === 'topical'
          ? `\n${e.id} — ${e.title} — a weak but topical match on your task, not a verdict; ` +
            `call cairn_find("${e.id}") if it looks like the same trap.\n`
          : `\n${e.id} — ${e.title} — a known, cheap-to-work-around trap on this path; ` +
            `call cairn_find("${e.id}") for the fix if the results look off.\n`;
    // `continue`, not `break`: an entry that overflows the budget is dropped
    // whole, but a smaller entry behind it can still fit — the comment above
    // promises exactly this ("a long first finding cannot swallow the two
    // behind it"), which `break` did not deliver.
    if (used + block.length > budget) continue;
    lines.push(block);
    used += block.length;
  }
  return lines.length > 1 ? lines.join('') : '';
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  /* Cut at a sentence end where one is near, so the trim does not read as damage. */
  const cut = t.slice(0, n);
  const stop = cut.lastIndexOf('. ');
  return (stop > n * 0.6 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`);
}
