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

if (holes.length === 0) process.exit(0);

console.log(`\n## ${holes.length} thing(s) you asked about that nothing useful was recorded on\n`);
for (const h of holes) console.log(`  - ${h.query.replace(/\s+/g, ' ').slice(0, 96)}`);
console.log(
  '\nIf you worked any of these out, record it now, while you still remember what\n' +
    'you expected. Nobody will write it later and the next agent pays the same cost.\n' +
    'Skip the ones you did not solve, and the ones that were your own mistake.\n',
);
