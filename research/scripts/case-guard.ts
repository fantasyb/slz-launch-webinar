/**
 * cairn:case-guard — which INDIVIDUAL held-out cases stopped working.
 *
 *   npm run cairn:case-guard            compare against the recorded outcomes
 *   npm run cairn:case-guard -- --bless record the current outcomes as the baseline
 *
 * The aggregate floors in research/quality-baseline.json have now been lowered twice for
 * the same reason: a finding was added, its own new case failed, and P@1 fell
 * because the denominator grew. Both times the note said the corpus changed and
 * not the ranker. Both times that was true -- and a floor that gets argued down
 * every time the corpus grows is a floor that will eventually be argued down
 * when the ranker really did break, in a commit whose message reads identically.
 *
 * An average cannot tell those apart, because it throws away the only thing that
 * distinguishes them: WHICH cases moved. A new finding failing its own first
 * case is the corpus growing. A case that passed last week and fails today is a
 * regression, and it is still a regression when the average went up.
 *
 * So outcomes are recorded per case, keyed by the case text rather than by
 * position, and this reports the set difference. Cases that did not exist at
 * bless time can never be regressions; cases that were already failing are not
 * re-reported. Blessing is deliberate and shows exactly what it is accepting.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import { loadCorpus } from '../../src/lib/cairn/load';
import { retrieve } from '../../src/lib/cairn/retrieval';
import { heldOutCases } from '../../src/lib/cairn/evalset';

const OUTCOMES = 'data/case-outcomes.json';

/*
 * Keyed on the query text, not on the finding id or an index. Editing a note
 * rewrites the query, which retires the old case and introduces a new one --
 * correct, because the old measurement no longer refers to anything.
 */
const key = (gold: string, q: string) => createHash('sha256').update(`${gold}\n${q}`).digest('hex').slice(0, 16);

interface Outcomes {
  _comment: string[];
  recordedAt: string;
  /** key -> the finding the case is about, for every case that PASSED. */
  passing: Record<string, string>;
}

function measure() {
  const all = loadCorpus();
  const passing: Record<string, string> = {};
  const failing: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const c of heldOutCases(all)) {
    const k = key(c.gold, c.q);
    seen.set(k, c.gold);
    const hits = retrieve(c.q, all);
    if (hits[0]?.finding.id === c.gold) passing[k] = c.gold;
    else failing[k] = `${c.gold} -> ${hits[0]?.finding.id ?? 'nothing'}`;
  }
  return { passing, failing, seen };
}

function main() {
  const bless = process.argv.includes('--bless');
  const { passing, failing, seen } = measure();
  const total = seen.size;

  if (bless) {
    const out: Outcomes = {
      _comment: [
        'Per-case held-out outcomes. Regenerate with: npm run cairn:case-guard -- --bless',
        '',
        'Keys are sha256(goldId + newline + query text), truncated. A case whose query',
        'text changes gets a new key and starts fresh, which is the intent: the old',
        'measurement referred to words that are no longer there.',
        '',
        'Only PASSING cases are recorded. Anything absent is either a case that was',
        'already failing or one that did not exist yet, and neither can regress.',
      ],
      recordedAt: new Date().toISOString().slice(0, 10),
      passing,
    };
    fs.writeFileSync(OUTCOMES, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n  recorded ${Object.keys(passing).length} passing of ${total} cases -> ${OUTCOMES}`);
    console.log(`  ${Object.keys(failing).length} failing, not recorded:\n`);
    for (const v of Object.values(failing)) console.log(`    ${v}`);
    console.log();
    return;
  }

  if (!fs.existsSync(OUTCOMES)) {
    console.error(`\n  no ${OUTCOMES} — run: npm run cairn:case-guard -- --bless\n`);
    process.exit(1);
  }
  const prev: Outcomes = JSON.parse(fs.readFileSync(OUTCOMES, 'utf8'));

  const regressed: string[] = [];
  const vanished: string[] = [];
  for (const [k, gold] of Object.entries(prev.passing)) {
    if (!seen.has(k)) { vanished.push(gold); continue; }
    if (!(k in passing)) regressed.push(failing[k] ?? gold);
  }
  const fresh = Object.keys(passing).filter((k) => !(k in prev.passing)).length;

  console.log(`\n  ${total} held-out cases · ${Object.keys(passing).length} passing`);
  console.log(`  baseline recorded ${prev.recordedAt}: ${Object.keys(prev.passing).length} passing`);
  if (vanished.length) console.log(`  ${vanished.length} baseline case(s) no longer exist (text edited or finding retired)`);
  if (fresh) console.log(`  ${fresh} newly passing case(s) not in the baseline`);

  if (!regressed.length) {
    console.log('\n  PASS — no case that passed at bless time fails now\n');
    return;
  }
  console.log(`\n  FAIL — ${regressed.length} case(s) that used to pass now fail:\n`);
  for (const r of regressed) console.log(`    ${r}`);
  console.log(
    '\n  This is the regression an average hides. If it is a deliberate trade,\n' +
      '  say which cases you are giving up and why, then re-bless in the SAME commit.\n',
  );
  process.exit(1);
}

main();
