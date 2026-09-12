/**
 * cairn:impact — did banked, verified knowledge actually save real work?
 *
 *   npm run cairn:impact                 # everything the ledger has ever recorded
 *   npm run cairn:impact -- --days 14    # just the last two weeks (the test window)
 *   npm run cairn:impact -- --since 2026-09-01
 *   npm run cairn:impact -- --json       # machine-readable, for a longer study
 *
 * This is the instrument the whole strategy argument was missing. It reads the
 * retrieval ledger (what the gateway actually served) and joins each PUSH
 * delivery — a finding that resonated on a live tool result at the moment its
 * trap manifested — to that finding's own rediscovery cost. The headline is a
 * raw count you can trust; the minutes are an explicit upper bound wearing their
 * assumptions on the outside. Reads what is on disk. No network, nothing leaves.
 */
import { readLedger } from '../src/lib/cairn/ledger';
import { loadCorpus } from '../src/lib/cairn/load';
import { homePath } from '../src/lib/cairn/home';
import { summarizeImpact, humanMinutes, COST_MINUTES, type FindingLite } from '../src/lib/cairn/impact';

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}
const asJson = argv.includes('--json');

/* The window: --since <ISO> wins, else --days N back from now, else all of time. */
let sinceMs: number | undefined;
const since = opt('since');
const daysBack = opt('days');
if (since) {
  const t = Date.parse(since);
  if (!Number.isNaN(t)) sinceMs = t;
  else process.stderr.write(`cairn:impact: could not parse --since "${since}"; showing all recorded time.\n`);
} else if (daysBack && Number(daysBack) > 0) {
  sinceMs = Date.now() - Number(daysBack) * 86_400_000;
}

const findingsById = new Map<string, FindingLite>();
for (const f of loadCorpus()) {
  findingsById.set(f.id, { id: f.id, title: f.title, cost: f.cost, tool: f.triggers?.[0] });
}

const s = summarizeImpact(readLedger(), findingsById, { sinceMs });

if (asJson) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const pad = (n: number) => String(n).padStart(5);
console.log(`\nCAIRN IMPACT — ${homePath()}`);
console.log('='.repeat(66));
const windowLabel = sinceMs ? `since ${new Date(sinceMs).toISOString().slice(0, 10)}` : 'all recorded time';
console.log(`  window: ${windowLabel}${s.days ? `  ·  ${s.days.toFixed(1)} days of activity` : ''}\n`);

if (s.pushFirstDeliveries === 0) {
  console.log('  No push deliveries recorded in this window.');
  console.log('  Either the gateway has not injected a resonating finding yet, or the');
  console.log('  window predates any. Both look the same here — widen --days, or check');
  console.log('  that a wrapped server (e.g. sf-all) has actually hit a known trap.\n');
} else {
  console.log('  PUSH — findings that fired UNASKED on a live tool result (resonated):\n');
  console.log(`    first deliveries        ${pad(s.pushFirstDeliveries)}   (distinct value-bearing events)`);
  console.log(`      · un-derivable (≥ hrs)${pad(s.unDerivableFires)}   ← the decision number: expensive traps a frontier model would NOT shrug off`);
  console.log(`      · cheap (minutes)     ${pad(s.cheapFires)}   (a capable agent likely recovers these alone)`);
  console.log(`    reminders               ${pad(s.pushReminders)}   (same trap, same session — not new value)`);
  console.log(`    distinct findings       ${pad(s.distinctFindings)}`);
  console.log(`    across tools            ${pad(s.tools)} · sessions ${s.sessions} · agents ${s.agents}\n`);

  console.log('  ESTIMATED rediscovery-time avoided (UPPER BOUND — assumes each first');
  console.log('  delivery prevented a cold rediscovery; the counts above are the fact):');
  console.log(`    all fires               ${humanMinutes(s.estMinutesUpperBound).padStart(9)}`);
  console.log(`    un-derivable only       ${humanMinutes(s.estMinutesUnDerivableOnly).padStart(9)}   ← the conservative, decision-grade figure`);
  console.log(`    (assumptions: minutes=${COST_MINUTES.minutes}m, hours=${COST_MINUTES.hours}m, days=${COST_MINUTES.days}m per fire)\n`);

  const top = s.fired.slice(0, 12);
  if (top.length) {
    console.log('  what fired, most valuable first (inspect these by hand):\n');
    for (const f of top) {
      const flag = f.cost === 'minutes' ? '   ' : ' ★ ';
      console.log(`   ${flag}${f.id}  ${f.cost.padEnd(7)} ×${f.firstDeliveries}  ${f.tool.slice(0, 22).padEnd(22)} ${f.title.replace(/\s+/g, ' ').slice(0, 40)}`);
    }
    console.log('\n   ★ = un-derivable/expensive. These are the fires that decide whether');
    console.log('     Cairn is a business or a very good personal tool. Read the top few:');
    console.log('     were they real saves, or noise? That judgment is the deliverable.\n');
  }
}

if (s.pullSurfaced) {
  console.log(`  PULL — ${s.pullSurfaced} asked-for retrieval(s) led with a confident finding (secondary signal).\n`);
}

console.log('  Counts are truth. Minutes are an estimate. Neither proves the');
console.log('  counterfactual — only reading the starred fires does.\n');
