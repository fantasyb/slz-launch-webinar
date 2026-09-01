/**
 * cairn:guard — quality must not regress, and nobody will notice if it does.
 *
 *   npm run cairn:guard
 *
 * Retrieval quality is invisible when it degrades. Nothing throws, no test goes
 * red, the answers just get slightly worse and stay that way. Three separate
 * regressions in this project were found only because somebody happened to
 * measure: a bigram change that cost 0.05 P@1, a language prior that cost 0.08
 * P@5, and a relevance gate that could not fire at all. Every one of them
 * looked fine.
 *
 * So the measured numbers are committed to quality-baseline.json and this
 * enforces them. It is the same discipline the corpus applies to its own
 * claims: a number nobody re-runs is an assumption.
 *
 * The three suites run CONCURRENTLY and against the same working tree, so they
 * cannot disagree about which code they measured. Run one after another, a
 * slow suite gives an edit time to land between them, and the report becomes a
 * blend of two versions that never existed together.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const exec = promisify(execFile);

interface Baseline {
  heldOut: { minP1: number; minP5: number; minMRR: number; minDelivery: number };
  field: { minP1: number; minQuiet: number };
  agent: { minCoveredHits: number; minSilentOnUnknown: number };
  corpus: { maxLintErrors: number; maxCheckSeconds: number };
}

const baseline: Baseline = JSON.parse(fs.readFileSync('quality-baseline.json', 'utf8'));

const failures: string[] = [];
const notes: string[] = [];

function check(name: string, actual: number, floor: number, higherIsBetter = true) {
  const ok = higherIsBetter ? actual >= floor : actual <= floor;
  const cmp = higherIsBetter ? '>=' : '<=';
  const line = `  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(28)} ${actual
    .toFixed(3)
    .padStart(7)}  ${cmp} ${floor}`;
  notes.push(line);
  if (!ok) failures.push(`${name}: ${actual.toFixed(3)} ${higherIsBetter ? '<' : '>'} ${floor}`);
}

async function run(cmd: string, args: string[]) {
  try {
    const r = await exec(cmd, args, { maxBuffer: 1 << 24 });
    return r.stdout + r.stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

async function main() {
  console.log('\nCAIRN QUALITY GUARD — four suites, concurrently, one working tree');
  console.log('='.repeat(66));

  const [evalOut, agentOut, lintOut, doctorOut, caseOut, fieldOut] = await Promise.all([
    run('npx', ['tsx', 'scripts/eval.ts']),
    run('npx', ['tsx', 'scripts/agent-eval.ts']),
    run('npx', ['tsx', 'scripts/lint-corpus.ts']),
    run('npx', ['tsx', 'scripts/doctor.ts']),
    run('npx', ['tsx', 'scripts/case-guard.ts']),
    run('npx', ['tsx', 'scripts/field-eval.ts']),
  ]);

  // --- held-out retrieval accuracy ---
  // The named line, not the first TOTAL row: see the note in eval.ts. Reading
  // a report's layout is how a gate ends up measuring the wrong section.
  const heldOut = evalOut.match(/HELDOUT n=\d+ p1=([\d.]+) p5=([\d.]+) mrr=([\d.]+)/);
  if (!heldOut) {
    failures.push('could not parse cairn:eval output — the guard is blind, which is a failure');
  } else {
    check('heldOut P@1', Number(heldOut[1]), baseline.heldOut.minP1);
    check('heldOut P@5', Number(heldOut[2]), baseline.heldOut.minP5);
    check('heldOut MRR', Number(heldOut[3]), baseline.heldOut.minMRR);
  }

  // Delivery is the number that corresponds to what the agent actually knows
  // after one query, so it is gated hardest.
  const del = evalOut.match(/DELIVERY\s+\d+\/\d+ \(([\d.]+)\)/);
  if (!del) failures.push('could not parse DELIVERY — the guard is blind to the headline metric');
  else check('heldOut delivery', Number(del[1]), baseline.heldOut.minDelivery);

  // --- agent simulation: covered ground, and silence on unknown ground ---
  const covered = (agentOut.match(/^HIT/gm) ?? []).length;
  const silent = (agentOut.match(/^QUIET/gm) ?? []).length;
  const noisy = (agentOut.match(/^NOISE/gm) ?? []).length;
  check('agent covered hits', covered, baseline.agent.minCoveredHits);
  check('agent silent on unknown', silent, baseline.agent.minSilentOnUnknown);
  notes.push(
    `  note  ${'agent false positives'.padEnd(28)} ${String(noisy).padStart(7)}  (documented, not gated)`,
  );

  // --- corpus integrity ---
  const lintErrors = Number(lintOut.match(/(\d+)\s+errors?/)?.[1] ?? '99');
  check('corpus lint errors', lintErrors, baseline.corpus.maxLintErrors, false);

  // --- no check may become too expensive to run unattended ---
  // Parsed from doctor's unconditional SUMMARY line. The previous version read
  // the human-readable slow-check section, which is printed only when a check
  // is slow -- so with nothing slow it found no line, reported 0, and passed a
  // threshold of one millisecond. A guard that cannot fail is not a guard.
  const summary = doctorOut.match(/SUMMARY .*slowest_ms=(\d+)/);
  if (!summary) {
    failures.push('could not parse doctor SUMMARY — the guard is blind to check cost');
  } else {
    check('slowest check (seconds)', Number(summary[1]) / 1000, baseline.corpus.maxCheckSeconds, false);
  }

  /*
   * --- field queries ---
   * The only suite whose queries nobody wrote for an eval. It scores thirty
   * points below the held-out one on the same retriever, which is the gap
   * between describing a symptom and describing a diagnosis. Gated separately
   * and never averaged in: a large author-written sample and a small real one
   * measure different things.
   */
  const field = fieldOut.match(/FIELD p1=([\d.]+) quiet=([\d.]+)/);
  if (!field) failures.push('could not parse cairn:field-eval — the guard is blind to the honest number');
  else {
    check('field P@1', Number(field[1]), baseline.field.minP1);
    check('field quiet-on-unknown', Number(field[2]), baseline.field.minQuiet);
  }

  /*
   * --- per-case regression ---
   * The floors above are averages, and an average cannot tell a corpus that
   * grew from a ranker that broke. This can: it names the individual cases
   * that used to pass and no longer do. It is the check the floors were being
   * asked to do and could not.
   */
  const regressed = caseOut.match(/FAIL — (\d+) case\(s\) that used to pass now fail/);
  if (caseOut.includes('no data/case-outcomes.json')) {
    failures.push('no per-case baseline — run: npm run cairn:case-guard -- --bless');
  } else if (regressed) {
    check('cases regressed', Number(regressed[1]), 0, false);
    for (const line of caseOut.split('\n').filter((l) => /^\s{4}cairn-\d+ ->/.test(l))) {
      notes.push(`  note  ${'  regressed'.padEnd(28)} ${line.trim()}`);
    }
  } else if (caseOut.includes('PASS — no case that passed at bless time fails now')) {
    check('cases regressed', 0, 0, false);
  } else {
    failures.push('could not parse cairn:case-guard output — the guard is blind to per-case regression');
  }

  console.log(notes.join('\n'));
  console.log('='.repeat(66));

  if (failures.length === 0) {
    console.log('PASS — nothing regressed below its recorded floor.\n');
    return;
  }
  console.log(`FAIL — ${failures.length} regression(s):\n`);
  for (const f of failures) console.log('  ' + f);
  console.log(
    '\nIf this change is a deliberate trade, say so in the commit message and move\n' +
      'the floor in quality-baseline.json in the SAME commit. Lowering a floor to\n' +
      'make a build pass is how a measurement stops measuring anything.\n',
  );
  process.exitCode = 1;
}

void main();
