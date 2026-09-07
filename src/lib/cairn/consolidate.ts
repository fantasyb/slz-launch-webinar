/**
 * Consolidation — the step sleep was missing: a harvested candidate becomes a
 * SERVED finding with nobody in the loop.
 *
 * THE INERT SYSTEM. Sleep harvests candidates into drafts/ automatically, and
 * every path from drafts/ to cairn/ then waited for something that never came:
 * a person reviewing `/cairn queue`, or a triage agent that only spawns where
 * execution is enabled — which it is not, by default, on purpose. So the queue
 * filled and the corpus learned nothing. Memory consolidation that leaves every
 * episode in the buffer is not consolidation.
 *
 * THE GATE IS REPLACED, NOT REMOVED. A ledger that auto-promotes everything
 * fills with noise, and noise here is existential: an agent that learns to skip
 * a noisy label skips the real findings too. So this pass holds the same bar
 * cairn_record holds today — it calls the same write path, with every gate in
 * it (secret/injection scan, a check that decides or is honestly manual, the
 * near-duplicate refusal, schema bounds) — and REPLACES the one thing that
 * write path cannot supply, "somebody decided this is worth recording", with a
 * gate a machine can apply without running shell:
 *
 *   - it is a sleep candidate that cleared the surprise gate on the strength of
 *     the agent's OWN model update, anchored to a notable result (sleep.ts) —
 *     not an error the agent shrugged past, not narration;
 *   - the firsthand triple is all there, in the agent's words: what it expected
 *     before the call, what the tool actually returned, and its correction
 *     after — each real (no placeholder), each concrete, expectation ≠ reality;
 *   - the cheap triage score clears a STRICTER bar than the expensive agent's
 *     (CONSOLIDATE_THRESHOLD), which is what culls the generic-reflex class —
 *     "just retry", "paginate" — a frontier model recovers on its own;
 *   - anything the scanner can redact is redacted first (the finding is private
 *     and never leaves the machine, but the scan is not tiered); anything it
 *     can only flag is refused.
 *
 * WHAT IT CANNOT DO, IT SAYS SO. It never runs a check: execution is off, and
 * even where it is on the live gate (triage.ts) owns the queue instead, because
 * a gate-verified finding is strictly better than this one. So a promoted
 * finding is recorded the way an agent submission is (origin 'agent': author
 * forced to SLEEP_OBSERVER, agentRecorded, private, never journalled for the
 * machine key to sign, its check never executed) with a MANUAL check, secondhand
 * provenance (the author re-ran nothing), a short half-life, and a
 * `consolidated` stamp naming the transcript and candidate it came from. Its
 * standing is `aging` at birth and decays to `stale` in about five weeks unless
 * someone observes it. It can never read as "verified by its check": the
 * observer is not `doctor`, the check is manual, and nothing signs it.
 *
 * EVERY CANDIDATE REACHES A VERDICT, AND NONE IS DROPPED. promote → cairn/ and
 * drafts/admitted/; reject (a duplicate, a scanner hit, below the bar) →
 * drafts/rejected/ with the reason; hold (real signal a machine cannot write
 * honestly: a structural contradiction with no correction in prose, a missing
 * expectation) → drafts/leads/ for a person or a live-gate machine. The yield
 * ledger records each, so "how much of what was harvested was served" stays a
 * measured number. Selection — decay, usage, later cairn_observe — culls what
 * does not earn its place; a person can retire (never delete) anything.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pendingCandidates, hasCheck, settle, type Candidate } from './triage';
import { scoreCandidate, harvestedText, DERIVABLE } from './triageScore';
import { recordSubmission, trimTo } from './recordFinding';
import { redactDeep } from './safety';
import { executionPolicy } from './policy';
import { MACHINE_OBSERVER } from './attest';

/**
 * The identity a consolidated finding's founding observation carries. It is a
 * machine, and it is NOT the machine that runs checks: `doctor` is the one
 * label verification() reads as "verified by its check", and this must never be
 * confused with it — a consolidated finding was read off a transcript, not run.
 */
export const SLEEP_OBSERVER = 'cairn-sleep';
if ((SLEEP_OBSERVER as string) === MACHINE_OBSERVER) throw new Error('SLEEP_OBSERVER must never alias the machine-check observer');

/**
 * A floor, stricter than DEFAULT_TRIAGE_THRESHOLD (0.5) because the expensive
 * agent that looks at 0.5 will then RUN a check and nothing here will. It is
 * not the reflex cull: measured, a candidate that reached drafts/ with a model
 * update carries +0.3 (structural) +0.1 (tool) +0.15 (exp≠real) over the 0.5
 * prior, so "just retry and paginate" still scores 0.75 after the -0.35
 * DERIVABLE penalty. The cull is therefore an explicit rule in gateCandidate on
 * the same DERIVABLE pattern; this floor catches what is thin on every other axis.
 */
export const CONSOLIDATE_THRESHOLD = 0.7;

/*
 * The agent's tell — "actually", "it turns out" — is what cleared the surprise
 * gate; it is not what the trap is. Left in the title, every consolidated
 * finding shared those two "significant" terms with every other, and the
 * near-duplicate gate (two shared terms) merged the second trap on any machine
 * into the first. Stripped from the title only; the mechanism keeps the words.
 */
const TELLS = /\b(?:actually|it turns out(?: that)?|turns out(?: that)?|as it turns out|hmm|oh|wait)\b[,\s—:-]*/gi;

/**
 * A finding nobody executed decays faster than one somebody watched fail. With
 * one unsigned observation from one environment, confidence at birth is
 * 1.0 × 0.5 × 0.9 = 0.45 (`aging`), and it reaches `stale` (0.3) when freshness
 * falls below 0.667 — 0.585 half-lives, so about 35 days at 60. A later
 * confirmed observation resets the clock; nothing else does.
 */
export const CONSOLIDATED_HALF_LIFE_DAYS = 60;

/** How long a consolidation lock is honoured before it is presumed abandoned. */
const LOCK = '.consolidate.lock';
const STALE_LOCK_MS = 10 * 60_000;
/** The report --surface hands the next session: what the last pass promoted. */
export const REPORT_FILE = '.consolidate-report.json';

export type GateVerdict =
  | { verdict: 'promote'; submission: Record<string, unknown>; reasons: string[] }
  | { verdict: 'reject' | 'hold' | 'skip'; reasons: string[] };

const str = (d: Record<string, unknown>, k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Prose fit for a quoted slot: one line, no double quotes, cut at a word boundary. */
const digest = (s: string, max: number): string => trimTo(squash(s).replace(/"/g, "'"), max);

const SHELL = /^(bash|shell|sh|exec|run|terminal|command)$/i;
/* The same verbs lint refuses as single-word triggers: a wrapper names a trap
 * only with its argument (`npm install`, never `npm`). */
const WRAPPER_VERBS = new Set(['npm', 'npx', 'git', 'yarn', 'pnpm', 'bun', 'cargo', 'go', 'pip', 'pip3', 'docker', 'make', 'brew', 'apt', 'apt-get']);
const TOKEN = /^[A-Za-z0-9_.-]+$/;

/**
 * What a shell candidate is ABOUT: the program the command invokes, as a
 * trigger prefix. `Bash` itself is not a subject — a trigger on it would fire on
 * every command an agent runs, which is the cry-wolf channel lint exists to
 * refuse. Env assignments and `sudo`/`env` are skipped; a wrapper verb takes its
 * subcommand. Null when nothing recognisable leads the command.
 */
export function shellSubject(command: string): string | null {
  const tokens = squash(command).split(' ').filter(Boolean);
  let i = 0;
  while (i < tokens.length && (/^[A-Z_][A-Z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo' || tokens[i] === 'env')) i++;
  const first = tokens[i]?.replace(/^.*\//, '');
  if (!first || !TOKEN.test(first) || first.length < 2) return null;
  if (WRAPPER_VERBS.has(first)) {
    const second = tokens[i + 1];
    return second && /^[a-z][a-z0-9-]*$/.test(second) ? `${first} ${second}` : null;
  }
  return first;
}

/** The subject and trigger a candidate's tool maps to, honest about ecosystem. */
function subjectOf(tool: string, input: Record<string, unknown>): { tool?: string; subject: { name: string; ecosystem: string; versions: string }; label: string } {
  if (SHELL.test(tool)) {
    const prog = shellSubject(typeof input.command === 'string' ? input.command : '');
    return prog
      ? { tool: prog, subject: { name: prog, ecosystem: 'shell', versions: '*' }, label: `${prog} (via ${tool})` }
      : { subject: { name: 'shell', ecosystem: 'shell', versions: '*' }, label: tool };
  }
  if (/^mcp__/.test(tool)) return { tool, subject: { name: tool, ecosystem: 'mcp', versions: '*' }, label: tool };
  return { tool, subject: { name: tool, ecosystem: 'agent-harness', versions: '*' }, label: tool };
}

/** The first sentence of the agent's correction that is long enough to be a title. */
function titleFrom(update: string): string {
  const sentences = squash(update).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const first = sentences.find((s) => s.length >= 20) ?? squash(update);
  const stripped = squash(first.replace(TELLS, ' ')).replace(/^[\s—:,-]+/, '').replace(/[.\s]+$/, '');
  return trimTo(stripped.length >= 20 ? stripped : first.replace(/[.\s]+$/, ''), 120);
}

/**
 * The automatic promotion gate. Pure: reads the candidate, decides, and — when
 * it promotes — builds the submission the one write path will validate. It
 * never touches disk and never runs anything.
 */
export function gateCandidate(data: Record<string, unknown>): GateVerdict {
  if (data._kind !== 'sleep-candidate') return { verdict: 'skip', reasons: ['not a sleep candidate (a note or a gateway draft belongs to its own tier)'] };
  if (hasCheck({ file: '', data })) return { verdict: 'skip', reasons: ['carries a runnable check — a triage agent is working it; the live gate owns it'] };

  const tool = str(data, 'tool').trim();
  const expectation = squash(harvestedText(str(data, 'expectation')));
  const reality = str(data, 'reality').trim();
  const update = squash(harvestedText(str(data, 'mechanism_or_update')));
  const why = Array.isArray(data.why) ? (data.why as unknown[]).map(String).join(' ') : '';

  const held: string[] = [];
  if (!tool) return { verdict: 'reject', reasons: ['no tool named'] };
  /* The firsthand triple, in the agent's own words. Anything a machine would
   * have to invent to fill in is a hold, not a promotion: the reframe is that
   * the finding is already written in the trace, and where it is not, it is
   * not this pass's to write. */
  if (!expectation) held.push('no expectation stated before the call');
  if (!reality) held.push('the tool returned nothing at all — a person must describe the emptiness');
  if (!update) held.push("no correction in the agent's own words after the result");
  if (!/revised its model/.test(why)) held.push("the surprise signal is structural only (no model update anchored to a notable result) — needs a live check or a person");
  if (held.length) return { verdict: 'hold', reasons: held };

  if (expectation.toLowerCase() === reality.toLowerCase()) return { verdict: 'reject', reasons: ['expectation and reality are identical — nothing was violated'] };
  if (update.length < 20 || expectation.length < 10) return { verdict: 'hold', reasons: ['too thin to state as a claim'] };
  /* The generic-reflex class — a workaround a frontier model already has —
   * pays nothing when banked (the records-opus nulls). The cheap score only
   * penalises it; here it is refused outright, because nothing downstream will
   * run a check that could prove the reflex insufficient. */
  const reflex = DERIVABLE.exec(update.toLowerCase());
  if (reflex) return { verdict: 'reject', reasons: [`generic-reflex correction ("${reflex[0]}") — frontier-recoverable, not worth serving`] };

  const score = scoreCandidate(data);
  if (score.score < CONSOLIDATE_THRESHOLD) {
    return { verdict: 'reject', reasons: [`cheap gate ${score.score} < ${CONSOLIDATE_THRESHOLD}: ${score.reasons.join('; ')}`] };
  }

  /* Build the submission from the candidate's own fields — verbatim where a
   * reader will read them, digested only inside the one-sentence claim. */
  const evidence = Array.isArray(data.evidence) ? (data.evidence as Array<Record<string, unknown>>) : [];
  const ev0 = evidence[0] ?? {};
  const command = typeof ev0.command === 'string' && ev0.command.trim() ? ev0.command : tool;
  const source = str(data, 'source') || 'an earlier transcript';
  const inputFromEvidence = (() => {
    const m = /^\S+\s+(\{[\s\S]*\})$/.exec(command);
    try { return m ? (JSON.parse(m[1]) as Record<string, unknown>) : {}; } catch { return {}; }
  })();
  const { tool: subjectTool, subject, label } = subjectOf(tool, inputFromEvidence);

  const claim =
    `Calling ${label} expecting "${digest(expectation, 200)}" returned "${digest(reality, 300)}"; ` +
    `the agent's own correction after the result: "${digest(update, 400)}".`;

  const submission: Record<string, unknown> = {
    title: titleFrom(update),
    claim,
    expectation: expectation.slice(0, 2000),
    reality: reality.slice(0, 4000),
    mechanism: `The agent's correction after the result, verbatim from the transcript: ${update}`.slice(0, 4000),
    evidence: [
      {
        command: command.slice(0, 4000),
        output: (typeof ev0.output === 'string' ? ev0.output : reality).slice(0, 20000),
        note: `verbatim from transcript ${source}; the consolidation pass re-ran nothing`.slice(0, 2000),
      },
    ],
    check: {
      command: `Call ${label} with the arguments recorded in the evidence and compare the result with the reality above.`,
      confirmedIf: 'the call returns what the reality field describes',
      refutedIf: 'the call returns what the expectation describes, or the correction no longer applies',
      manual: true,
    },
    ...(subjectTool ? { tool: subjectTool } : {}),
    subject,
    kind: 'trap',
    /* Unknown, honestly: the agent lost at least one turn to it. The lowest
     * tier keeps a never-executed finding in the hint channel, not the full push. */
    cost: 'minutes',
    tags: ['consolidated', 'unverified'],
    provenance: 'secondhand',
    halfLifeDays: CONSOLIDATED_HALF_LIFE_DAYS,
    share: false,
    environment: { os: process.platform, arch: process.arch, runtime: `node ${process.version}`, note: `${os.type()} ${os.release()}; consolidated from transcript ${source}` },
    note:
      `Consolidated by cairn:sleep from transcript ${source}: the session's agent made this call and saw this result; ` +
      'the consolidation pass re-ran nothing and no check was executed. Standing decays until someone observes it (cairn_observe or cairn:verify).',
    by: SLEEP_OBSERVER,
  };
  return { verdict: 'promote', submission, reasons: [`cheap gate ${score.score}: ${score.reasons.join('; ')}`] };
}

export interface ConsolidateResult {
  /** The pass did not run at all, and why. */
  skippedBecause?: 'disabled' | 'execution-enabled' | 'locked' | 'no-queue';
  promoted: Array<{ candidate: string; id: string; title: string }>;
  rejected: Array<{ candidate: string; reason: string }>;
  held: Array<{ candidate: string; reason: string }>;
  /** Left pending for a transient reason (a write race); retried next pass. */
  deferred: Array<{ candidate: string; reason: string }>;
  skipped: number;
}

function takeLock(dir: string): boolean {
  const lock = path.join(dir, LOCK);
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
  } catch {
    /* no lock */
  }
  try {
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  } catch {
    return false;
  }
}

function stamp(c: Candidate, verdict: string, reasons: string[]): void {
  try {
    c.data._consolidate = { verdict, reasons, at: new Date().toISOString(), by: SLEEP_OBSERVER };
    fs.writeFileSync(c.file, JSON.stringify(c.data, null, 2) + '\n');
  } catch {
    /* the ledger carries the verdict too; the stamp is a convenience for a reader of drafts/ */
  }
}

/** Classify a write-path refusal: which are terminal (content will not change) and which retry. */
function refusalIsTransient(message: string): boolean {
  return /just created by another writer/.test(message);
}

/**
 * Run the consolidation pass over one corpus's queue. Serialised by a lock so
 * the session-end hook, the session-start trigger and a daemon tick cannot
 * promote the same candidate twice or mint the same id. Never throws.
 */
export async function consolidate(draftsDir: string): Promise<ConsolidateResult> {
  const out: ConsolidateResult = { promoted: [], rejected: [], held: [], deferred: [], skipped: 0 };
  if (process.env.CAIRN_AUTO_CONSOLIDATE === '0') return { ...out, skippedBecause: 'disabled' };
  /*
   * Where checks may run, the live gate is strictly better — a discriminating
   * check, RUN on the machine where the trap is live, by a triage agent — and it
   * owns the queue: cairn:triage-trigger spawns the agent, cairn:triage settles
   * verdicts, and the cheap gate's below-bar candidates stay pending to be
   * re-gated free. Consolidating there would promote unverified what the agent
   * was about to verify, and stamp as rejected what the agent's gate keeps.
   */
  if (executionPolicy().enabled) return { ...out, skippedBecause: 'execution-enabled' };
  const pending = pendingCandidates(draftsDir);
  if (!pending.length) return { ...out, skippedBecause: 'no-queue' };
  if (!takeLock(draftsDir)) return { ...out, skippedBecause: 'locked' };
  try {
    for (const c of pending) {
      const name = path.basename(c.file);
      let g: GateVerdict;
      try {
        g = gateCandidate(c.data);
      } catch (e) {
        out.deferred.push({ candidate: name, reason: `gate threw: ${(e as Error).message}` });
        continue;
      }
      if (g.verdict === 'skip') { out.skipped++; continue; }
      if (g.verdict === 'hold') {
        stamp(c, 'hold', g.reasons);
        settle(draftsDir, c, 'lead', `held by consolidation — ${g.reasons.join('; ')}`);
        out.held.push({ candidate: name, reason: g.reasons.join('; ') });
        continue;
      }
      if (g.verdict === 'reject') {
        stamp(c, 'reject', g.reasons);
        settle(draftsDir, c, 'rejected', `rejected by consolidation — ${g.reasons.join('; ')}`);
        out.rejected.push({ candidate: name, reason: g.reasons.join('; ') });
        continue;
      }
      if (g.verdict !== 'promote') continue;
      /* Redact first, so a home path or a token in raw tool output is rewritten
       * rather than refused; what the redactor cannot rewrite, the write path's
       * own scan refuses, and that refusal is recorded. */
      const { value: submission } = redactDeep(g.submission);
      let r;
      try {
        r = await recordSubmission(submission, {
          origin: 'agent',
          by: SLEEP_OBSERVER,
          consolidated: { transcript: String(c.data.source ?? 'unknown').slice(0, 300), candidate: name.slice(0, 300), at: new Date().toISOString() },
        });
      } catch (e) {
        out.deferred.push({ candidate: name, reason: `record threw: ${(e as Error).message}` });
        continue;
      }
      if (!r.ok) {
        if (refusalIsTransient(r.message)) { out.deferred.push({ candidate: name, reason: r.message.split('\n')[0] }); continue; }
        const reason = r.message.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').slice(0, 400);
        stamp(c, 'reject', [reason]);
        settle(draftsDir, c, 'rejected', `refused by the write path — ${reason}`);
        out.rejected.push({ candidate: name, reason });
        continue;
      }
      const f = r.finding!;
      stamp(c, 'promote', [`consolidated as ${f.id}`, ...g.reasons]);
      settle(draftsDir, c, 'admitted', `consolidated as ${f.id} — unverified, secondhand, manual check; standing decays until observed`);
      out.promoted.push({ candidate: name, id: f.id, title: f.title });
    }
    if (out.promoted.length) writeReport(draftsDir, out);
  } finally {
    try { fs.rmSync(path.join(draftsDir, LOCK), { force: true }); } catch { /* stale-reclaimed next time */ }
  }
  return out;
}

/** Leave a note for the next session start: what sleep consolidated while nobody was looking. */
function writeReport(dir: string, r: ConsolidateResult): void {
  try {
    const prior = readReport(dir);
    const promoted = [...(prior?.promoted ?? []), ...r.promoted];
    fs.writeFileSync(path.join(dir, REPORT_FILE), JSON.stringify({ at: new Date().toISOString(), promoted }, null, 2) + '\n');
  } catch {
    /* the report is a courtesy; the corpus and the ledger are the record */
  }
}

export function readReport(dir: string): { at: string; promoted: ConsolidateResult['promoted'] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8')) as { at?: unknown; promoted?: unknown };
    return typeof raw.at === 'string' && Array.isArray(raw.promoted) ? { at: raw.at, promoted: raw.promoted as ConsolidateResult['promoted'] } : null;
  } catch {
    return null;
  }
}

/** Consume the report: the next session start reads it once, then it is gone. */
export function takeReport(dir: string): { at: string; promoted: ConsolidateResult['promoted'] } | null {
  const r = readReport(dir);
  if (r) { try { fs.rmSync(path.join(dir, REPORT_FILE), { force: true }); } catch { /* reported twice at worst */ } }
  return r;
}

/** One line per outcome for a log or a terminal. */
export function describe(r: ConsolidateResult): string {
  if (r.skippedBecause === 'disabled') return 'consolidation is off (CAIRN_AUTO_CONSOLIDATE=0)';
  if (r.skippedBecause === 'execution-enabled') return 'execution is enabled for this corpus, so the live gate (cairn:triage) owns the queue; nothing consolidated unverified';
  if (r.skippedBecause === 'locked') return 'another consolidation pass holds the lock';
  if (r.skippedBecause === 'no-queue') return 'queue empty';
  const lines = [
    `consolidated ${r.promoted.length} finding(s), rejected ${r.rejected.length}, held ${r.held.length} as leads` +
      (r.deferred.length ? `, ${r.deferred.length} retried next pass` : '') + (r.skipped ? `, ${r.skipped} left to their own tier` : ''),
    ...r.promoted.map((p) => `  ${p.id}  ${p.title}`),
    ...r.rejected.map((x) => `  rejected ${x.candidate}: ${x.reason}`),
    ...r.held.map((x) => `  held ${x.candidate}: ${x.reason}`),
  ];
  return lines.join('\n');
}
