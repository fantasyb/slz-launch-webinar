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
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';
import { confirmCandidates } from '../src/lib/cairn/confirm';
import { alsoSeenWith } from '../src/lib/cairn/graph';

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const query = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!query) {
  console.error('usage: npm run cairn:find -- "<error text>" [--confirm]');
  process.exit(2);
}

const all = loadCorpus();
const hits = retrieve(query, all, { useLocalEnvironment: true, limit: 5 });

if (hits.length === 0) {
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
  console.log(`  ${h.finding.id}  ${h.score.toFixed(1).padStart(6)}  ${h.finding.title}`);
  console.log(
    `      ${h.finding.status === 'retired' ? 'RETIRED · ' : ''}` +
      `confidence ${(h.confidence * 100).toFixed(0)}%${applies}`,
  );
  console.log(`      matched: ${h.matched.slice(0, 5).map((m) => m.term).join(', ')}`);
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
  console.log('\nrunning checks (local corpus only)...\n');
  const results = await confirmCandidates(
  hits.map((h) => h.finding),
  { max: 3 },
  );

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
