/**
 * cairn:gate — does this check distinguish the trap from its absence?
 *
 *   npm run cairn:gate            # every runnable finding
 *   npm run cairn:gate cairn-0008 # one
 *
 * Static rules catch the checks that never decide anything; this catches the
 * ones that look like they decide and do not. It runs the check, applies the
 * finding's own `absentWhen`, and runs it again: same answer twice means the
 * check was reporting that a shell ran.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { assertLocalCorpus } from '../src/lib/cairn/confirm';
import { gate } from '../src/lib/cairn/gate';
import { checkFlaws } from '../src/lib/cairn/checkquality';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const corpus = loadCorpus().filter((f) => f.status !== 'retired');
const targets = only.length ? corpus.filter((f) => only.includes(f.id)) : corpus;
/* Same rule as confirm: a check from an upstream corpus is never executed. */
assertLocalCorpus(targets);

const tally: Record<string, number> = {};

for (const f of targets) {
  const flaws = checkFlaws(f.check);
  if (flaws.length) {
    tally['static-flaw'] = (tally['static-flaw'] ?? 0) + 1;
    if (only.length) console.log(`  ${f.id}  static-flaw — ${flaws[0].detail}`);
    continue;
  }
  const r = await gate(f);
  tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  if (only.length || r.verdict === 'discriminates' || r.verdict === 'same-either-way') {
    console.log(`  ${f.id}  ${r.verdict}\n      ${r.detail}`);
  }
}

console.log(`\n${targets.length} finding(s)`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
console.log(
  '\n`discriminates` is the only verdict that means the check is worth anything to doctor.\n',
);
