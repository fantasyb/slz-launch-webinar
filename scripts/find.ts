/**
 * cairn:find — retrieval from the command line.
 *
 *   npm run cairn:find -- "ENOSPC: no space left on device"
 *   npm run cairn:find -- "playwright browsers missing" --confirm
 *
 * Unlike /api/search this runs on the machine asking the question, so it can
 * use two signals the HTTP path cannot: preconditions evaluated against this
 * environment, and — with --confirm — the checks themselves.
 */
import { loadSearchable, type SearchableFinding } from '../src/lib/cairn/federation';
import { retrieve } from '../src/lib/cairn/retrieval';
import { confirmCandidates } from '../src/lib/cairn/confirm';
import { alsoSeenWith } from '../src/lib/cairn/graph';
import { preflight } from '../src/lib/cairn/retrieval';
import { observe } from '../src/lib/cairn/observe';
import { corpusPresent, homePath } from '../src/lib/cairn/home';
import { stalenessNote } from '../src/lib/cairn/freshness';

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
/*
 * `--preflight`, not `--before`: npm has its own `--before` option and eats it
 * before the script ever sees it, so the flag silently did nothing when run
 * through `npm run`. It worked when invoked directly, which is the worst
 * version of that bug.
 */
const before = argv.includes('--preflight');
const query = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!query) {
  console.error('usage: npm run cairn:find -- "<error text>" [--confirm]');
  console.error('       npm run cairn:find -- --preflight "<command you are about to run>"');
  process.exit(2);
}

/*
 * --before: the corpus speaks first.
 *
 * Every other path here is a pull, which means the cost has already been paid
 * -- you search after the failure. This fires on the command itself, before
 * it runs, and is the only mode that can prevent the afternoon rather than
 * explain it. Exit 0 always: this is advice, not a gate, and a tool that can
 * block a command is a tool people stop invoking.
 */
if (before) {
  const warnings = preflight(query, loadSearchable().findings, { useLocalEnvironment: true });
  if (warnings.length === 0) {
    console.log(`\nnothing known about \`${query}\`.\n`);
    process.exit(0);
  }
  console.log(`\nbefore you run \`${query}\`:\n`);
  for (const w of warnings) {
    console.log(`  ! ${w.finding.id}  ${w.finding.title}`);
    console.log(`      triggered by "${w.trigger}"${w.applicability === 'holds' ? '  [precondition holds here]' : ''}`);
    if (w.finding.workaround) {
      console.log(`      ${w.finding.workaround.split('\n')[0].slice(0, 96)}`);
    }
    console.log();
  }
  process.exit(0);
}

/*
 * Local corpus AND every subscribed upstream. Searching only the local
 * directory is what made the two-tier design a page on the website: a
 * personal corpus with forty findings cached from its upstream answered
 * "No corpus found."
 */
const all = loadSearchable().findings;
const hits = retrieve(query, all, { useLocalEnvironment: true, limit: 5 });
/*
 * Written down before it is printed. Until now every query this corpus ever
 * answered was discarded the moment it was served, which is why the only
 * measurements of delivery in this project were harvested by hand.
 */
observe(query, hits, 'cli:find');

if (hits.length === 0) {
  /*
   * An empty corpus and an empty ANSWER are different facts, and until this
   * check existed they printed the same sentence. Run from another project the
   * corpus failed to LOAD, and the CLI reported that as knowledge: "nothing in
   * the corpus matches". A reader would conclude the ledger is empty; it was
   * simply somewhere else.
   */
  if (!corpusPresent() && all.length === 0) {
    console.error(
      `\n  No corpus found. Looked in ${homePath('cairn')}, and in every\n` +
        '  upstream this corpus subscribes to.\n' +
        '  Set CAIRN_HOME to the checkout, or run the CLI by its full path so it\n' +
        '  can find its own install. This is not an empty ledger — it is no ledger.\n',
    );
    process.exit(2);
  }
  console.log(`\nnothing in the corpus matches "${query}".`);
  console.log('If you solve it, that is exactly what belongs here: npm run cairn:new\n');
  process.exit(0);
}

console.log(`\n${hits.length} finding(s) for "${query}"\n`);
for (const h of hits) {
  const applies =
    h.applicability === 'holds'
      ? ' [precondition holds here]'
      : h.applicability === 'fails'
        ? ' [precondition does NOT hold here]'
        : '';
  /*
   * An upstream finding is shown under its NAMESPACED id and named as
   * somebody else's. Two corpora can both hold a cairn-0002 and mean
   * different things; printing the native id for both would present a
   * stranger's claim as one of yours.
   */
  const fed = h.finding as SearchableFinding;
  console.log(
    `  ${fed.displayId ?? h.finding.id}  ${h.score.toFixed(1).padStart(6)}  ${h.finding.title}`,
  );
  console.log(
    `      ${h.finding.status === 'retired' ? 'RETIRED · ' : ''}` +
      `confidence ${(h.confidence * 100).toFixed(0)}%${applies}` +
      `${fed.upstreamOrigin ? ` · from ${fed.upstreamOrigin}` : ''}`,
  );
  console.log(`      matched: ${h.matched.slice(0, 5).map((m) => m.term).join(', ')}`);
  if (h.confusedWith.length) {
    console.log(
      `      often confused with ${h.confusedWith.join(', ')} — measured, not guessed; ` +
        'check those too',
    );
  }
  if (h.strength === 'weak') {
    console.log(`      WEAK MATCH — ${h.caveats.join('; ')}. Judge it before acting on it.`);
  }
  if (h.siblings.length) {
    console.log(
      `      same trap as ${h.siblings.join(', ')} — read both; the ranking ` +
        'between them is not meaningful',
    );
  }
}

/*
 * What else the same machine tends to hit.
 *
 * Shown only for the top hit, and only as a footnote, because it answers a
 * question the agent did not ask. It is worth the two lines because these
 * edges connect findings that share no vocabulary at all -- the sandbox with
 * no `dig` is the sandbox that redirects UDP/53 -- so no ranking over the
 * query could ever have surfaced them.
 *
 * The attester count is printed rather than hidden. An edge backed by one
 * attester is one agent's afternoon, and presenting that as a pattern would be
 * the corpus doing exactly what it exists to stop.
 */
const top = hits[0];
const near = alsoSeenWith(top.finding.id, all, { limit: 3 }).filter(
  (e) => !hits.some((h) => h.finding.id === e.id),
);
if (near.length) {
  const parties = Math.max(...near.map((e) => e.attesters));
  console.log(
    `\nSeen on the same machines as ${top.finding.id}` +
      (parties < 2 ? ' (one attester only — a single agent\'s session, not a pattern)' : ''),
  );
  for (const e of near) {
    const f = all.find((x) => x.id === e.id)!;
    console.log(`  ${e.id}  ${f.title.slice(0, 62)}`);
  }
}

if (!confirm) {
  console.log('\nPass --confirm to RUN the top checks and see which failure is actually');
  console.log('present here. That executes shell from your local corpus — read it first.\n');
  process.exit(0);
}

// tsx emits CJS for this script, where top-level await is unavailable, so the
// executing half runs inside main(). Nothing above here is async.
async function main() {
  /*
   * Local findings only, and the rest reported rather than dropped.
   *
   * confirm refuses to execute an upstream check on purpose (cairn-0014:
   * running a command a stranger's repository supplies is the whole RCE
   * primitive). Once find started searching upstreams, every hit was passed
   * in regardless and the guard threw a raw stack trace at anyone who typed
   * --confirm on a personal corpus. The refusal is right; announcing it as a
   * crash was not.
   */
  const local = hits.filter((h) => !(h.finding as SearchableFinding).upstreamName);
  const skipped = hits.length - local.length;
  console.log('\nrunning checks (local corpus only)...\n');
  const results = await confirmCandidates(
    local.map((h) => h.finding),
    { max: 3 },
  );
  if (skipped > 0) {
    console.log(
      `  ${skipped} upstream finding(s) not run — a check from another corpus is not executed here.`,
    );
  }

  for (const r of results) {
  const mark =
    r.fired === 'fires' ? 'REPRODUCES HERE' : r.fired === 'does-not-fire' ? 'does not reproduce' : r.fired;
  console.log(`  ${r.id}  ${mark}${r.ms ? ` (${r.ms}ms)` : ''}`);
  if (r.detail) console.log(`      ${r.detail}`);
  }

  const fired = results.filter((r) => r.fired === 'fires');
  console.log(
  fired.length
    ? `\n${fired.length} finding(s) reproduce on this machine right now: ${fired.map((f) => f.id).join(', ')}\n`
    : '\nNone of the checked findings reproduce here. Your failure is probably new.\n',
  );
}

void main();

/*
 * Said last, so it never buries the answer, and said at all because a corpus
 * that is behind answers in exactly the tone of one that is current.
 */
{
  const note = stalenessNote();
  if (note) console.error(`  (${note})`);
}
