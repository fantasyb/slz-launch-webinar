/**
 * cairn:quick — every accuracy suite, one line, fast.
 *
 *   npm run cairn:quick
 *   npm run cairn:quick -- --folds 5      cross-validated, see below
 *
 * The guard is the gate and takes seconds because it executes real checks.
 * This is the thing you run while SWEEPING a weight, and it exists because
 * the alternative — a throwaway script rewritten from memory each time — was
 * rewritten five times in one session and measured a slightly different thing
 * each time.
 *
 * WHY IT REPORTS ALL FOUR SUITES AND NOT JUST P@1
 *
 * Every improvement in this file's history that turned out to be a trade
 * looked like a win on one suite. Author prose and machine stderr have
 * disagreed repeatedly, and the ability to return NOTHING is invisible to
 * both. A single line carrying all four is the cheapest way to stop a trade
 * from being reported as a victory.
 *
 * CROSS-VALIDATION, AND WHY IT IS HERE
 *
 * There are 38 held-out cases and, at 0.895, four failures. Any new signal has
 * 34 correct answers to protect and 4 to repair, so a signal accurate 74% of
 * the time must fire almost exclusively on those 4 to break even — and a gate
 * built by INSPECTING those 4 is fitted to the eval set. That is not a
 * hypothetical: it is the reason three separate compression-based selectors
 * were rejected (see retrieval.ts).
 *
 * `--folds k` partitions the cases, and reports accuracy on each fold. A
 * genuine improvement moves every fold in roughly the same direction. A fitted
 * one moves the fold containing the cases it was built from and nothing else,
 * which is visible here and invisible in the aggregate. It is not a substitute
 * for a real held-out set — the folds share a corpus — but it catches the
 * specific failure this project keeps walking into.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';
import { heldOutCases, inSampleCases, type EvalCase } from '../src/lib/cairn/evalset';

const all = loadCorpus();
const argv = process.argv.slice(2);
const foldArg = argv.indexOf('--folds');
const folds = foldArg >= 0 ? Number(argv[foldArg + 1]) : 0;

const cases = heldOutCases(all);
const inSample = inSampleCases(all);

function score(subset: EvalCase[]) {
  let p1 = 0, p5 = 0, rr = 0, delivered = 0;
  const misses: string[] = [];
  for (const c of subset) {
    const hits = retrieve(c.q, all);
    const r = hits.findIndex((h) => h.finding.id === c.gold);
    if (r === 0) { p1++; delivered++; } else {
      misses.push(c.gold);
      const top = hits[0];
      if (top && (top.siblings.includes(c.gold) || top.confusedWith.includes(c.gold))) delivered++;
    }
    if (r >= 0 && r < 5) p5++;
    if (r >= 0) rr += 1 / (r + 1);
  }
  const n = subset.length;
  return { n, p1: p1 / n, p5: p5 / n, mrr: rr / n, delivery: delivered / n, misses };
}

const machine: Array<[string, string]> = [
  ['ENOSPC: no space left on device, write', 'cairn-0008'],
  ['no space left on device', 'cairn-0008'],
  ['curl: (56) CONNECT tunnel failed, response 403', 'cairn-0001'],
  ['rg: regex parse error: (?:interface{}) repetition quantifier', 'cairn-0003'],
  ['/bin/sh: 1: dig: not found', 'cairn-0002'],
  ['/bin/sh: 1: nslookup: not found', 'cairn-0002'],
  ['Filesystem Size Used Avail Use% Mounted on /dev/vda 252G 8.5G 29G 23% /', 'cairn-0008'],
  ['proxies blocked', 'cairn-0001'],
];
const unknown = [
  'Traceback (most recent call last): File "<string>", line 1, in <module> ModuleNotFoundError: No module named nonexistent_module_xyz',
  "error: pathspec 'does-not-exist-branch-xyz' did not match any file(s) known to git",
  'cat: /etc/gshadow: Permission denied',
];

const m = machine.filter(([q, gold]) => retrieve(q, all)[0]?.finding.id === gold).length;
const u = unknown.filter((q) => {
  const h = retrieve(q, all);
  return h.length === 0 || h.every((x) => x.strength === 'weak');
}).length;

const t = process.hrtime.bigint();
for (let i = 0; i < 200; i++) retrieve(machine[i % machine.length][0], all);
const ms = Number(process.hrtime.bigint() - t) / 1e6 / 200;

const a = score(cases);
const tripwire = score(inSample);
console.log(
  `held-out P@1 ${a.p1.toFixed(3)}  P@5 ${a.p5.toFixed(3)}  MRR ${a.mrr.toFixed(3)}  ` +
  `delivery ${a.delivery.toFixed(3)}  |  machine ${m}/${machine.length}  ` +
  `silent ${u}/${unknown.length}  |  ${ms.toFixed(3)}ms`,
);
console.log(
  `  n=${a.n} held out (observation notes + prediction reasoning, quotation-filtered).  ` +
  `in-sample tripwire ${tripwire.p1.toFixed(3)} over ${tripwire.n} — measures nothing, catches a broken index.`,
);
if (a.misses.length) console.log(`  misses: ${a.misses.join(' ')}`);

if (folds > 1) {
  console.log(`\nCROSS-VALIDATION (${folds} folds) — a real gain moves every fold, a fitted one moves one`);
  for (let k = 0; k < folds; k++) {
    const sub = cases.filter((_, i) => i % folds === k);
    const s = score(sub);
    console.log(`  fold ${k}  n=${String(s.n).padStart(2)}  P@1 ${s.p1.toFixed(3)}  MRR ${s.mrr.toFixed(3)}`);
  }
}
