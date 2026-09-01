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
import { retrieve } from './retrieval';

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

/** One line per finding, in the order the retriever ranked them. */
export interface BriefEntry {
  id: string;
  title: string;
  reality: string;
  workaround?: string;
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
  return retrieve(task, corpus, {
    useLocalEnvironment: opts.useLocalEnvironment,
    limit: Math.max(limit * 3, 9),
  })
    /*
     * The retriever's own weak/strong label rather than a score threshold: it
     * already accounts for whether the terms that matched were ordinary
     * English, and rebuilding that judgement from a raw score here would be a
     * second, worse copy of it. The label alone is calibrated for a reader who
     * asked, though, so injection adds the coverage floor above.
     */
    .filter((h) => h.strength === 'strong' && h.explained >= MIN_EXPLAINED)
    .slice(0, limit)
    .map((h) => ({
      /*
       * The namespaced id for an upstream finding. The brief is read by an
       * agent that may then cite the id back, and on a corpus subscribed to
       * an upstream "cairn-0001" names two different claims.
       */
      id: (h.finding as { displayId?: string }).displayId ?? h.finding.id,
      title: h.finding.title,
      reality: h.finding.reality,
      ...(h.finding.workaround ? { workaround: h.finding.workaround } : {}),
    }));
}

/**
 * The brief as text, ready to prepend to a system prompt. Empty when there is
 * nothing worth saying, which is most of the time.
 */
export function brief(task: string, corpus: Finding[], opts: BriefOptions = {}): string {
  const entries = briefEntries(task, corpus, opts);
  if (!entries.length) return '';
  const budget = opts.maxChars ?? DEFAULTS.maxChars;

  const head =
    'Before you start: someone has already hit the following in this codebase or on this ' +
    'machine, and recorded it. These were retrieved by matching your task, so judge whether ' +
    'each one actually applies — a match is not a verdict.\n';

  const lines: string[] = [head];
  let used = head.length;
  for (const e of entries) {
    /*
     * Trimmed per entry rather than truncating the whole block, so a long
     * first finding cannot silently swallow the two behind it.
     */
    const block =
      `\n${e.id} — ${e.title}\n  WHAT HAPPENS: ${clip(e.reality, 420)}` +
      (e.workaround ? `\n  INSTEAD: ${clip(e.workaround, 420)}` : '') +
      '\n';
    if (used + block.length > budget) break;
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
