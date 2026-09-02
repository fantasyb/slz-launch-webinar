/**
 * What this session asked that the corpus could not answer.
 *
 *   npm run cairn:unanswered
 *
 * The autonomous half of "bank that". A person says it because they noticed
 * they had struggled; an agent running unattended has nobody to notice for
 * it, and asking it to introspect is the weakest available trigger — having
 * just solved something is exactly the state in which it does not feel hard.
 *
 * The ledger already holds a better signal, recorded by a mechanism with no
 * opinion: a query that returned nothing. That is a hole in the corpus,
 * timestamped at the moment it opened. If the agent went on to solve the
 * thing, the finding is worth having and nobody has written it.
 *
 * Prints nothing when there is nothing, because a reminder that fires every
 * time is one that gets ignored.
 */
import { readLedger } from '../src/lib/cairn/ledger';
import { who } from '../src/lib/cairn/observe';
import { listNotes, ageDays } from '../src/lib/cairn/notes';
import { readArcs } from '../src/lib/cairn/arcs';
import fs from 'fs';
import path from 'path';

const { session } = who();
const SINCE_MS = Number(process.env.CAIRN_UNANSWERED_WINDOW_MIN ?? 240) * 60_000;
const cutoff = Date.now() - SINCE_MS;

const silent = readLedger().filter((r) => {
  /*
   * A hole is "nothing STRONG came back", not "nothing came back".
   *
   * retrieve returns weak matches for almost any text, so an empty `returned`
   * array is nearly unreachable: two queries about Data 360 and Slack — which
   * this corpus knows nothing whatever about — each came back with five weak
   * hits and would have been counted as answered. A detector keyed on that
   * would have shipped and never fired once.
   *
   * The strong/weak label is the same judgement `brief` uses to decide
   * whether a finding is worth handing over unasked, so "no strong match" is
   * the corpus's own word for having nothing useful.
   */
  if ((r.returned ?? []).some((h) => h.strength === 'strong')) return false;
  /*
   * This session, or failing that a recent window. `CAIRN_SESSION` is not
   * always set — an agent invoking the CLI directly gets 'adhoc' — and a
   * reminder that only works under ideal instrumentation is one that never
   * fires in practice.
   */
  if (session !== 'adhoc' && r.session === session) return true;
  return session === 'adhoc' && Date.parse(r.at) >= cutoff;
});

/* Same question asked three ways is one hole, not three. */
const seen = new Set<string>();
const holes = silent.filter((r) => {
  const k = r.query.trim().toLowerCase().slice(0, 60);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

/* Notes: noticed and written down, in one call, and not yet thought through. Open ones only; abandoned ones are the report's. */
let open: ReturnType<typeof listNotes> = [];
try { open = listNotes().filter((n) => n.state === 'open'); } catch { /* no drafts, no notes */ }

/*
 * The session-end sweep. The Bash hook remembers fail-then-recover arcs for
 * this session in a state file; the ones it put a question on and that were
 * not banked are still there. And a live detector misses the quiet failures
 * -- "looked like success but wasn't" -- which nothing can see without the
 * person; this is the one place to ask, once, with no task interrupted.
 */
interface BashState { fired?: Array<{ key: string; arc?: string; failing: string; working: string; at: string; muted?: string | null }> }
let arcs: NonNullable<BashState['fired']> = [];
try {
  const file = path.join(process.env.TMPDIR || '/tmp', `cairn-bash-${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  if (session !== 'adhoc' && fs.existsSync(file)) arcs = (JSON.parse(fs.readFileSync(file, 'utf8')) as BashState).fired ?? [];
} catch { /* no state, no arcs */ }

/* Only the arcs that were offered and never answered: the answered ones are in ~/.cairn/arcs.jsonl. */
const answered = new Set(readArcs().filter((r) => r.choice !== 'offered').map((r) => r.arc));
const unanswered = arcs.filter((a) => !a.muted && (!a.arc || !answered.has(a.arc)));
if (unanswered.length) {
  console.log(`\n## ${unanswered.length} fail-then-recover arc(s) this session you did not answer\n`);
  for (const a of unanswered) console.log(`  - ${a.arc ?? ''} \`${a.key}\`: failed as \`${a.failing.slice(0, 70)}\`, then \`${a.working.slice(0, 70)}\` worked`);
  console.log('\nOne call each: cairn_note with the arc to bank it, or cairn_note {"dismiss": "<arc>", "as": "my-mistake" | "not-surprising"}.\n' +
    'And the quiet kind -- a call that looked like success and was not -- leaves no arc; if there was one this session,\n' +
    'it is worth a note now.\n');
}

if (open.length) {
  console.log(`\n## ${open.length} note(s) you left unfinished\n`);
  for (const n of open) console.log(`  - ${n.note.id}  ${Math.floor(ageDays(n.note))}d  ${n.note.tool}: ${n.note.title.slice(0, 80)}`);
  console.log('\nEach has the evidence already. Finish it with cairn_record, passing note: "<id>", or discard it.\n');
}
if (holes.length === 0 && open.length === 0 && unanswered.length === 0) process.exit(0);
if (holes.length === 0) process.exit(0);

console.log(`\n## ${holes.length} thing(s) you asked about that nothing useful was recorded on\n`);
for (const h of holes) console.log(`  - ${h.query.replace(/\s+/g, ' ').slice(0, 96)}`);
console.log(
  '\nIf you worked any of these out, record it now, while you still remember what\n' +
    'you expected. Nobody will write it later and the next agent pays the same cost.\n' +
    'Skip the ones you did not solve, and the ones that were your own mistake.\n',
);
