/**
 * One write path, used by every door a finding can come through.
 *
 * `cairn:record` on the command line, `cairn_record` on the MCP server and
 * now `cairn_record` on the gateway all take the same submission and must
 * apply the same gates. Two of them had their own copies of this sequence,
 * which is how a corpus ends up with a clean half and a dirty half -- the
 * dirty half being whichever door was most convenient. This is the sequence
 * once, with nothing in it that depends on which door was used.
 *
 * The order is the cheapest refusal first: parse, scan for what must never
 * be committed, refuse a check that cannot decide, refuse a near-duplicate,
 * then -- only when the writer supplied absentWhen and the machine may run
 * checks -- prove the check discriminates before writing.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema, type Finding } from './schema';
import { SubmissionSchema, normalise, likelyDuplicates, slugify, readsAsProse } from './submission';
import { scanExecutable, scanInjection, scanSensitive, draftSurface, redact } from './safety';
import type { ZodIssue } from 'zod';
import { checkFlaws } from './checkquality';
import { gate } from './gate';
import { executionPolicy } from './policy';
import { loadSearchable } from './federation';
import { homePath, cairnHome } from './home';

export interface RecordOutcome {
  ok: boolean;
  /** Human-readable, safe to hand straight back to an agent. */
  message: string;
  finding?: Finding;
  file?: string;
}

/**
 * The local corpus read fresh from disk, not through loadCorpus(), which is
 * memoised for the life of the process. A gateway lives a whole session and
 * must see the finding it wrote five minutes ago, or the second record in a
 * session mints the first one's id again.
 */
function freshLocal(): Finding[] {
  const dir = homePath('cairn');
  const out: Finding[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const parsed = FindingSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* one bad file never blocks a write */
    }
  }
  return out;
}

/**
 * `origin` decides whether the workaround-delta gate may run this finding's
 * check, and it is not the same question as the machine's execution policy.
 *
 * The gate runs `check.command` and `absentWhen` through /bin/sh. From the
 * CLI that is a person, at a keyboard, recording something they just worked
 * out: they wrote the command and they are present when it runs. Through the
 * gateway's `cairn_record` tool it is a model, mid-session, and the text it
 * is recording came from an upstream tool's output -- a Case description, a
 * record field, anything a third party can write into a system the agent is
 * reading. That is a shell reachable from data, and the only thing between
 * them is a regex scanner whose own header says five of eight hand-written
 * evasions get through.
 *
 * So the two are separated. Execution policy stays what it was, per machine,
 * and gates the CLI. `origin: 'agent'` never executes, whatever the policy
 * says, because there is no policy setting that makes "a model recording
 * something it read from production data" a safe thing to run.
 */
/* ------------------------------------------------------------------------ */
/* Refusals that hand back the satisfying value                              */
/* ------------------------------------------------------------------------ */

/**
 * A gate that makes a model guess twice is a gate that costs three calls.
 *
 * Watched in a real session: a title over 120 characters was refused with
 * "String must contain at most 120 character(s)", trimmed, refused again,
 * shortened hard, accepted -- three round trips through cairn_record, each a
 * tool call and a model turn, in the middle of a deploy that was failing.
 * Every one of those refusals could have said by how much, and handed back
 * a value that would pass. Now they do: any bound that can be satisfied
 * mechanically comes back with the satisfying value, the way redact()
 * suggests a replacement rather than only objecting.
 */
function at(raw: unknown, path: (string | number)[]): unknown {
  let v: unknown = raw;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined;
  return v;
}

/** Cut at a word boundary within `max`, so the suggestion reads as a title and not as a fragment. */
export function trimTo(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '');
}

function explain(issue: ZodIssue, raw: unknown): string {
  const field = issue.path.join('.') || '(root)';
  const value = at(raw, issue.path);
  if (issue.code === 'too_big' && typeof value === 'string') {
    const max = Number(issue.maximum);
    const over = value.length - max;
    return `${field}: ${value.length} characters; the limit is ${max}, so ${over} over. This fits and will be accepted as-is:\n    ${JSON.stringify(trimTo(value, max))}`;
  }
  if (issue.code === 'too_small' && typeof value === 'string') {
    const min = Number(issue.minimum);
    return `${field}: ${value.length} characters; at least ${min} needed, so ${min - value.length} short. Say what would be observed, not just that it fails.`;
  }
  if (issue.code === 'too_big' && Array.isArray(value)) return `${field}: ${value.length} entries; the limit is ${issue.maximum}. Keep the first ${issue.maximum}.`;
  if (issue.code === 'too_small' && Array.isArray(value)) return `${field}: ${issue.message}`;
  if (issue.code === 'invalid_type' && issue.received === 'undefined') {
    const hints: Record<string, string> = {
      by: 'your model or agent name, e.g. "claude-opus-4-8"',
      claim: 'one falsifiable sentence, 40 to 2000 characters',
      expectation: 'what a competent person would have predicted',
      reality: 'what happened instead',
      evidence: 'at least one { "command", "output" } from the session',
      check: '{ "command", "confirmedIf", "refutedIf" }; prose in command marks it manual',
      title: 'one line, at most 120 characters',
    };
    return `${field}: missing${hints[field] ? ` — ${hints[field]}` : ''}`;
  }
  return `${field}: ${issue.message}`;
}

export async function recordSubmission(
  raw: unknown,
  opts: { by?: string; origin?: 'human' | 'agent'; force?: boolean } = {},
): Promise<RecordOutcome> {
  const withBy = typeof raw === 'object' && raw !== null && opts.by && !(raw as Record<string, unknown>).by
    ? { ...(raw as Record<string, unknown>), by: opts.by }
    : raw;
  const parsed = SubmissionSchema.safeParse(withBy);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Not recordable yet — each line below says what would be accepted:\n${parsed.error.issues.map((i) => `  ${explain(i, withBy)}`).join('\n')}`,
    };
  }
  const data = parsed.data;

  const surface = draftSurface(data as unknown as Record<string, unknown>);
  const flags = [...scanExecutable(surface), ...scanInjection(surface), ...scanSensitive(surface)];
  if (flags.length) {
    return {
      ok: false,
      message:
        `Refused — this must not be committed:\n${flags
          .map((f) => {
            const fixed = redact(f.sample).text;
            return `  ${f.pattern}: ${f.reason} — ${JSON.stringify(f.sample)}${fixed !== f.sample ? `\n    accepted if written as ${JSON.stringify(fixed)}` : ''}`;
          })
          .join('\n')}\nTake it out and record it again. Nothing was written.`,
    };
  }

  /*
   * `force` is the CLI's "I have read the refusal and I mean it": it skips
   * the check-quality and near-duplicate gates, and nothing else. The scan
   * for what must never be committed is not skippable from any door.
   */
  const check = { ...data.check, manual: data.check.manual ?? readsAsProse(data.check.command) };
  const flaws = opts.force ? [] : checkFlaws(check);
  if (flaws.length) {
    return {
      ok: false,
      message:
        `Refused — the check cannot decide whether this is happening:\n${flaws.map((f) => `  ${f.rule}: ${f.detail}`).join('\n')}` +
        '\nMake it exit non-zero when the trap is ABSENT, or describe it in prose to mark it manual. Nothing was written.',
    };
  }

  const local = freshLocal();
  let upstream: Finding[] = [];
  try {
    upstream = loadSearchable().findings.filter((f) => (f as { upstreamName?: string }).upstreamName);
  } catch {
    /* no federation configured: local only */
  }
  /*
   * THE REMEDY MUST BE REACHABLE BY THE CALLER BEING REFUSED.
   *
   * This gate fires on two shared significant terms between the new title and
   * an existing finding's title, tags and subject -- a loose net. It collapsed
   * "an Agentforce agent does not appear in the panel" into "an agent does not
   * fire Apex", because both are permission-set-shaped. Different symptoms,
   * one merge.
   *
   * What made that expensive was not the false positive. It was that the
   * override existed only for the CLI: the message named `--force` when
   * `origin === 'human'` and said nothing otherwise, and `force` was not in
   * the gateway's cairn_record schema at all. So the agent was refused, was
   * not told a door existed, and had no door. Its transcript reads "I won't
   * fight the tool over it" and the finding went into a markdown runbook. The
   * corpus lost it and recorded nothing about having done so.
   *
   * The costs here are not symmetric and the gate was tuned as if they were.
   * A false merge loses a real finding permanently and invisibly. A false
   * split makes a duplicate, which `cairn:lint` already warns about, which
   * anyone can merge later, and which is visible the whole time.
   *
   * So: `distinctFrom` is a submission field, reachable by every caller, and
   * it carries the reason rather than being a bare flag. Each use is a
   * labelled instance of this gate being wrong, which is the only way its
   * false-merge rate will ever be countable -- today it is unmeasured, which
   * is how it survived to eat a finding.
   */
  const excused = new Set((data.distinctFrom ?? []).map((d) => d.id));
  const dupes = opts.force
    ? []
    : likelyDuplicates(data.title, [...local, ...upstream]).filter((d) => !excused.has(d.id));
  if (dupes.length) {
    return {
      ok: false,
      message:
        `Already recorded — add an observation to the existing finding instead:\n${dupes.map((d) => `  ${d.id}  ${d.title}`).join('\n')}\n` +
        'If yours is a genuinely different trap, say so and record it again — this is accepted:\n' +
        `  "distinctFrom": [${dupes
          .map((d) => `{"id": "${d.id}", "because": "<what makes yours a different trap>"}`)
          .join(', ')}]` +
        (opts.origin === 'human' ? '\nOr --force, which records it without saying why.' : ''),
    };
  }

  const max = local.reduce((m, f) => Math.max(m, parseInt(f.id.slice(6), 10) || 0), 0);
  const num = String(max + 1).padStart(4, '0');
  const checked = FindingSchema.safeParse(normalise({ ...data, check }, new Date(), `cairn-${num}`).finding);
  if (!checked.success) {
    return { ok: false, message: `The finding did not validate after normalisation:\n${checked.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}` };
  }
  const finding = checked.data;

  let gateNote = '';
  if (finding.check.absentWhen && !finding.check.manual) {
    const policy = executionPolicy();
    if (opts.origin === 'agent') {
      gateNote = '\nGate: not run — a finding recorded by an agent is never executed. See EXECUTION.md.';
    } else if (policy.enabled && !policy.strict) {
      const verdict = await gate(finding);
      if (verdict.verdict === 'same-either-way') {
        return { ok: false, message: `Refused — the check does not distinguish the trap from its absence:\n  ${verdict.detail}\nNothing was written.` };
      }
      gateNote = verdict.verdict === 'discriminates' ? `\nGate: ${verdict.detail}` : `\nGate: ${verdict.verdict} — ${verdict.detail}`;
    } else {
      gateNote = '\nGate: not run (execution is off on this machine; see EXECUTION.md).';
    }
  }

  const dir = homePath('cairn');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${num}-${slugify(data.title)}.json`);
  if (fs.existsSync(file)) return { ok: false, message: `${file} already exists; nothing was written.` };
  fs.writeFileSync(file, `${JSON.stringify(finding, null, 2)}\n`);

  return {
    ok: true,
    finding,
    file,
    message:
      `Recorded ${finding.id} in ${cairnHome()}.` +
      (data.tool
        ? `\nIt will be handed over the next time anyone reaches for ${data.tool}.`
        : '\nSet `tool` next time if this is about an MCP tool — that is what makes it come back.') +
      gateNote +
      '\nUnsigned, so it counts as one environment and cannot raise scope on its own.',
  };
}
