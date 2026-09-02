/**
 * Fail-then-recover arcs, and what the person said about each one.
 *
 * The Bash hook detects an arc -- a command failed, the same program later
 * worked -- and puts one question in front of the agent with three answers:
 * bank it, my mistake, not surprising. Two distinct discards, because a slip
 * the agent made and a failure it already understood are different things;
 * only one is an error, neither is a trap, and collapsing them loses the
 * difference.
 *
 * THE THREE TALLIES ARE THE DETECTOR'S CALIBRATION. A preponderance of "my
 * mistake" means it fires on slips and should tighten; of "not surprising",
 * on ordinary work; a healthy share of "bank it" means it is aimed. The
 * choice is recorded with the arc so `cairn:report` can show the ratio, and
 * the offer is recorded too, so an arc nobody answered is counted rather
 * than lost. A detector nobody measured is the thing this repository exists
 * to refuse; this one measures itself.
 *
 * WHERE, AND FOR HOW LONG. A discard has to be remembered or the same arc
 * re-offers itself every session and becomes the nag that gets muted. It is
 * remembered in ~/.cairn/arcs.jsonl -- per person, per machine, outside any
 * corpus, beside the execution policy -- because a discard is about this
 * person's work and not about what a finding says. Lifetimes differ because
 * the things do: a slip is unlikely to recur identically, so "my mistake"
 * mutes that exact failing command for a week; an expected failure recurs
 * every time, so "not surprising" mutes the exact command for ninety days
 * and, after three such answers on one program, the program itself. A
 * banked arc is remembered for a month so the note is not re-offered while
 * it is being finished. Nothing is kept forever; readers prune by age.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

export type Choice = 'offered' | 'bank' | 'my-mistake' | 'not-surprising';

export interface ArcRecord {
  at: string;
  /** arc-<8 hex>, from the key and the failing command. */
  arc: string;
  /** Program and subcommand, the shape the corpus triggers on. */
  key: string;
  failing: string;
  choice: Choice;
  by?: string;
}

export const LIFETIME_DAYS: Record<Exclude<Choice, 'offered'>, number> = { 'my-mistake': 7, 'not-surprising': 90, bank: 30 };
/** "Not surprising" this many times on one program mutes the program. */
export const MUTE_PROGRAM_AFTER = 3;

export function arcsFile(): string {
  return process.env.CAIRN_ARCS || path.join(os.homedir(), '.cairn', 'arcs.jsonl');
}

export function arcId(key: string, failing: string): string {
  return `arc-${createHash('sha256').update(`${key}\n${failing.trim()}`).digest('hex').slice(0, 8)}`;
}

export function readArcs(): ArcRecord[] {
  try {
    return fs
      .readFileSync(arcsFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ArcRecord);
  } catch {
    return [];
  }
}

export function recordArc(r: Omit<ArcRecord, 'at'>): ArcRecord {
  const rec = { at: new Date().toISOString(), ...r };
  const file = arcsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  return rec;
}

const days = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 86_400_000;

/** Whether an arc should stay quiet, and why. */
export function muted(key: string, failing: string, now = new Date()): string | null {
  const id = arcId(key, failing);
  const live = readArcs().filter((r) => r.choice !== 'offered' && days(r.at, now) <= LIFETIME_DAYS[r.choice as Exclude<Choice, 'offered'>]);
  const exact = live.filter((r) => r.arc === id).sort((a, b) => b.at.localeCompare(a.at))[0];
  if (exact) return `${exact.choice} on ${exact.at.slice(0, 10)}`;
  const program = live.filter((r) => r.key === key && r.choice === 'not-surprising');
  if (program.length >= MUTE_PROGRAM_AFTER) return `not surprising ${program.length} times on \`${key}\``;
  return null;
}

/** The calibration: per choice, over a window, with the unanswered offers counted. */
export function tally(windowDays = 30, now = new Date()): { offered: number; bank: number; myMistake: number; notSurprising: number; unanswered: number } {
  const recent = readArcs().filter((r) => days(r.at, now) <= windowDays);
  const answered = new Set(recent.filter((r) => r.choice !== 'offered').map((r) => r.arc));
  const offered = new Set(recent.filter((r) => r.choice === 'offered').map((r) => r.arc));
  return {
    offered: offered.size,
    bank: recent.filter((r) => r.choice === 'bank').length,
    myMistake: recent.filter((r) => r.choice === 'my-mistake').length,
    notSurprising: recent.filter((r) => r.choice === 'not-surprising').length,
    unanswered: [...offered].filter((a) => !answered.has(a)).length,
  };
}
