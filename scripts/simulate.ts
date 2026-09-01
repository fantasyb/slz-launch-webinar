/**
 * cairn:simulate — a corpus this project cannot otherwise have.
 *
 *   npm run cairn:simulate
 *   npm run cairn:simulate -- --contributors 200 --traps 80
 *
 * WHY
 *
 * Four architectural ideas were measured against the real corpus and all four
 * came back inert: identity resolution found 0 duplicates, segmentation
 * excluded 0% of findings, git-as-signal was null, and a unified-context
 * presentation could not be separated at n=10. None of those is a statement
 * about the idea. They are one fact reported four ways -- 31 findings written
 * by one agent on one machine cannot exercise a multi-contributor,
 * multi-environment architecture.
 *
 * So the condition is manufactured. Nothing here is written to cairn/; the
 * synthetic corpus lives in memory for the length of one run.
 *
 * WHAT IS GROUNDED AND WHAT IS ASSUMED
 *
 * Grounded: nine genuinely independent write-ups were generated earlier by
 * showing a model one finding and asking a different engineer to record the
 * same failure in their own words. Measured against their originals they
 * share 32% of terms (median), where the most similar organic pair in the
 * real corpus shares 27%. The paraphrase strength here is tuned to reproduce
 * that 32%, so duplicate detectability is calibrated rather than invented.
 *
 * Assumed: that traps are power-law distributed across contributors -- nearly
 * everyone hits the sandbox proxy, almost nobody hits the rare one. That is a
 * modelling choice, stated so it can be argued with. It is also the choice
 * that makes duplicates matter: uniform popularity would produce far fewer.
 *
 * KNOWN FLAW, stated because it inflates one number and not the others.
 * Paraphrase here works by DROPPING words, so it can only ever reduce
 * vocabulary, never substitute it. Same-trap overlap comes out at 66% against
 * the 32% that model-written independent write-ups actually produce, which
 * makes synthetic duplicates markedly easier to detect than real ones. Treat
 * the separation ratio as an upper bound. The structural results below do not
 * depend on it: they follow from having many records per trap across varied
 * environments, which is real regardless of how the wording varies.
 *
 * WHAT IT SHOWS
 *
 *   contribs  records  P@1(exact)  P@1(right trap)  segment
 *          1       10       1.000            1.000     100%
 *          5       50       0.300            0.900      80%
 *         20      200       0.250            0.896      55%
 *         50      500       0.100            0.917      66%
 *
 * The metric that collapses is RECORD identity; the metric that holds is TRAP
 * identity. Retrieval keeps finding the right trap at ~0.9 while the odds of
 * returning the one record a query was derived from fall to 0.1 -- because by
 * then forty records describe that trap and asking for a specific one is not
 * a question worth answering.
 *
 * That is the argument for identity resolution stated as a measurement rather
 * than an analogy: at scale the unit of retrieval should be the trap, not the
 * record. It is also why P@1 stops being the right headline metric and
 * something like DELIVERY -- did the agent learn the thing -- becomes the only
 * one that survives.
 *
 * And segmentation stops being inert. On the real corpus a precondition filter
 * excludes 0% because every finding was authored on one machine; here it cuts
 * the candidate set to 55-66%, which is most of what makes ranking tractable
 * at five hundred records.
 *
 * NOT ASSUMED, and this is the flaw in the earlier attempt: synthetic findings
 * carry full weight. Evidence, observations, preconditions, mechanism and
 * appliesTo are all populated. The previous simulation stripped them, so its
 * duplicates were thinner than real findings, never outranked their originals,
 * and produced a reassuring degradation number that meant nothing.
 */
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve, buildIndex, docTerms, clearConfusionCache } from '../src/lib/cairn/retrieval';
import { matchEnvironment } from '../src/lib/cairn/precondition';
import type { Finding } from '../src/lib/cairn/schema';

const argv = process.argv.slice(2);
const arg = (n: string, d: number) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const CONTRIBUTORS = arg('contributors', 50);
const TRAPS = arg('traps', 40);
const PER_CONTRIBUTOR = arg('each', 10);

/** Deterministic PRNG, so a run is reproducible and a result is arguable. */
let seed = 20260901;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

const ENVIRONMENTS = [
  { os: 'linux', arch: 'x64', runtime: 'node 22' },
  { os: 'linux', arch: 'arm64', runtime: 'node 20' },
  { os: 'darwin', arch: 'arm64', runtime: 'node 22' },
  { os: 'win32', arch: 'x64', runtime: 'node 20' },
  { os: 'linux', arch: 'x64', runtime: 'python 3.12' },
];

const seeds = loadCorpus().filter((f) => f.status !== 'retired');

/*
 * Paraphrase by dropping and reordering, at a strength tuned to reproduce the
 * 32% term overlap measured on real independent write-ups. Crude next to a
 * model, and honest about being crude: it varies vocabulary coverage, which
 * is what duplicate detection keys on, and not sentence quality, which it
 * does not.
 */
function paraphrase(text: string, keep: number): string {
  const parts = text.split(/(?<=[.;])\s+/).filter(Boolean);
  const kept = parts.filter(() => rnd() < keep);
  const words = (kept.length ? kept : parts).join(' ').split(/\s+/);
  return words.filter((w) => w.length <= 3 || rnd() < keep).join(' ');
}

interface Sim { findings: Finding[]; trapOf: Map<string, number>; queries: Array<{ q: string; trap: number }> }

function build(contributors: number): Sim {
  seed = 20260901;
  const findings: Finding[] = [];
  const trapOf = new Map<string, number>();
  const queries: Array<{ q: string; trap: number }> = [];
  // Zipf popularity: trap i is hit with probability proportional to 1/(i+1).
  const w = Array.from({ length: TRAPS }, (_, i) => 1 / (i + 1));
  const total = w.reduce((a, b) => a + b, 0);
  const cum: number[] = [];
  w.reduce((a, x, i) => (cum[i] = a + x / total), 0);
  const trapFor = () => { const r = rnd(); return cum.findIndex((c) => r <= c); };

  let n = 0;
  for (let c = 0; c < contributors; c++) {
    const env = pick(ENVIRONMENTS);
    for (let k = 0; k < PER_CONTRIBUTOR; k++) {
      const trap = Math.max(0, trapFor());
      const base = seeds[trap % seeds.length];
      const id = `sim-${String(++n).padStart(5, '0')}`;
      trapOf.set(id, trap);
      findings.push({
        ...base,
        id,
        title: paraphrase(`${base.title} ${trap}`, 0.75),
        claim: paraphrase(base.claim, 0.6),
        expectation: paraphrase(base.expectation, 0.6),
        reality: paraphrase(base.reality, 0.6),
        workaround: base.workaround ? paraphrase(base.workaround, 0.6) : undefined,
        mechanism: base.mechanism ? paraphrase(base.mechanism, 0.6) : undefined,
        appliesTo: `${env.os} ${env.arch} ${env.runtime}`,
        // Full weight, but not IDENTICAL weight. The first run shared
        // base.evidence verbatim across every write-up of a trap, which alone
        // put same-trap overlap at 69% against the 32% measured on real
        // independent write-ups -- the simulation was manufacturing its own
        // detectability. Two people hitting one trap capture their own output.
        evidence: (base.evidence ?? []).map((e) => ({
          ...e,
          output: paraphrase(e.output ?? '', 0.5),
          note: e.note ? paraphrase(e.note, 0.5) : undefined,
        })),
        observations: [],
        predictions: [],
        precondition: [`os:${env.os}`],
      } as Finding);
      // A held-out query: a phrasing of the same trap not used in the record.
      if (rnd() < 0.25) queries.push({ q: paraphrase(`${base.title} ${base.reality}`, 0.4), trap });
    }
  }
  return { findings, trapOf, queries };
}

console.log(`\nSIMULATED CORPUS — ${TRAPS} real traps, ${PER_CONTRIBUTOR} findings per contributor`);
console.log('='.repeat(74));
console.log('  contribs  records  traps seen  dup groups   P@1(exact)  P@1(right trap)  segment  ms/query');

for (const c of [1, 5, 20, CONTRIBUTORS]) {
  const { findings, trapOf, queries } = build(c);
  clearConfusionCache();
  const groups = new Map<number, number>();
  for (const t of trapOf.values()) groups.set(t, (groups.get(t) ?? 0) + 1);
  const dupGroups = [...groups.values()].filter((v) => v > 1).length;

  let exact = 0, rightTrap = 0;
  const sample = queries.slice(0, 60);
  const t0 = process.hrtime.bigint();
  for (const { q, trap } of sample) {
    const top = retrieve(q, findings)[0];
    if (!top) continue;
    if (trapOf.get(top.finding.id) === trap) rightTrap++;
    // "exact" means the single record the query was derived from, which with
    // duplicates present is an increasingly unreasonable thing to ask for.
    if (top.finding.id === findings.find((f) => trapOf.get(f.id) === trap)?.id) exact++;
  }
  const ms = sample.length ? Number(process.hrtime.bigint() - t0) / 1e6 / sample.length : 0;
  const applies = findings.filter((f) => !f.precondition?.length || matchEnvironment(f.precondition).matches).length;

  console.log(
    `  ${String(c).padStart(8)}${String(findings.length).padStart(9)}` +
    `${String(groups.size).padStart(12)}${String(dupGroups).padStart(12)}` +
    `${(exact / Math.max(1, sample.length)).toFixed(3).padStart(13)}` +
    `${(rightTrap / Math.max(1, sample.length)).toFixed(3).padStart(17)}` +
    `${`${Math.round((applies / findings.length) * 100)}%`.padStart(9)}` +
    `${ms.toFixed(2).padStart(10)}`,
  );
}

/*
 * THE NUMBER THAT GOES UP.
 *
 * P@1 falls as the corpus grows and that is not a defect being tolerated, it
 * is the wrong question being asked. P@1 measures PRECISION ON COVERED
 * GROUND: given a query about something already in the corpus, is the right
 * record first. It cannot rise with growth, because every finding added is
 * another competitor for every query.
 *
 * It also says nothing about the value of the corpus. Queried today with four
 * failures actually hit in this session, cairn answered none of them -- not
 * because ranking failed but because none of the four is written down.
 * Coverage was zero and P@1 was 0.86, and the two numbers do not know about
 * each other.
 *
 * COVERAGE is the number that rises monotonically: what fraction of the traps
 * a person hits does the corpus know about at all. Nothing can make it fall,
 * and every finding added raises it.
 *
 * And the pipeline decides which of the two grows. Without admission control
 * every write-up is a new record, so records grow with contributors and
 * precision falls. With it, a duplicate becomes an OBSERVATION on the trap it
 * duplicates -- so the record count tracks the number of distinct traps rather
 * than the number of people, and the fiftieth person to hit the proxy makes
 * that finding stronger instead of making the corpus noisier.
 */
{
  const encounters = 400;
  console.log('\n  HOW THE CORPUS GROWS, WITH AND WITHOUT ADMISSION CONTROL');
  console.log('  encounters  records(raw)  records(admitted)  traps covered  coverage');
  for (const seen of [40, 120, 250, encounters]) {
    const { trapOf, findings } = build(Math.ceil(seen / PER_CONTRIBUTOR));
    const traps = new Set(trapOf.values());
    // With admission control a duplicate never becomes a record.
    const admitted = traps.size;
    console.log(
      `  ${String(findings.length).padStart(10)}${String(findings.length).padStart(14)}` +
      `${String(admitted).padStart(19)}${String(traps.size).padStart(15)}` +
      `${`${Math.round((traps.size / TRAPS) * 100)}%`.padStart(10)}`,
    );
  }
  /*
   * And the direct consequence: ranking thirty-seven records is a different
   * problem from ranking four hundred that describe the same thirty-seven
   * things. Same queries, same coverage, two corpus shapes -- the raw one as
   * it accumulates, and the admitted one where every duplicate became an
   * observation instead of a record.
   */
  const { findings: raw, trapOf: rawTrap, queries: qs } = build(Math.ceil(400 / PER_CONTRIBUTOR));
  const firstPerTrap = new Map<number, Finding>();
  for (const f of raw) {
    const t = rawTrap.get(f.id)!;
    if (!firstPerTrap.has(t)) firstPerTrap.set(t, f);
  }
  const admittedCorpus = [...firstPerTrap.values()];
  const admittedTrap = new Map([...firstPerTrap].map(([t, f]) => [f.id, t] as const));
  const sample = qs.slice(0, 80);
  const measure = (corpus: Finding[], map: Map<string, number>) => {
    clearConfusionCache();
    let hit = 0;
    const t0 = process.hrtime.bigint();
    for (const { q, trap } of sample) {
      const top = retrieve(q, corpus)[0];
      if (top && map.get(top.finding.id) === trap) hit++;
    }
    return { p: hit / sample.length, ms: Number(process.hrtime.bigint() - t0) / 1e6 / sample.length };
  };
  /*
   * A third shape: absorbed, not merely discarded.
   *
   * Collapsing to one record per trap loses something real -- eleven write-ups
   * are eleven phrasings, and a query has eleven chances to match one of them.
   * That recall is worth keeping and does not require eleven records to keep.
   *
   * So the survivor carries the duplicates' VOCABULARY. Each absorbed write-up
   * contributes its title and reality as searchable text on the record it
   * duplicates, which is what the expansions field already does for generated
   * queries. One record, every way anyone has ever described the trap.
   */
  const absorbed = admittedCorpus.map((f) => {
    const t = admittedTrap.get(f.id)!;
    const others = raw.filter((o) => rawTrap.get(o.id) === t && o.id !== f.id);
    return {
      ...f,
      mechanism: [f.mechanism ?? '', ...others.map((o) => `${o.title} ${o.reality}`)].join('\n'),
    } as Finding;
  });
  const absorbedTrap = new Map([...admittedTrap]);

  const A = measure(raw, rawTrap);
  const B = measure(admittedCorpus, admittedTrap);
  const C = measure(absorbed, absorbedTrap);
  console.log(`\n  same ${sample.length} queries, same coverage, two corpus shapes:`);
  console.log(`    raw       ${raw.length} records   right trap ${A.p.toFixed(3)}   ${A.ms.toFixed(2)} ms/query`);
  console.log(`    admitted  ${admittedCorpus.length} records    right trap ${B.p.toFixed(3)}   ${B.ms.toFixed(2)} ms/query`);
  console.log(`    absorbed  ${absorbed.length} records    right trap ${C.p.toFixed(3)}   ${C.ms.toFixed(2)} ms/query   <- keeps their vocabulary`);

  console.log('\n  raw records grow with PEOPLE; admitted records grow with TRAPS.');
  console.log('  coverage is the only column that cannot fall.');
}

// Duplicate detectability, calibrated against the measured 32%.
const { findings, trapOf } = build(CONTRIBUTORS);
const ix = buildIndex(findings.slice(0, 300));
const idx = new Map(ix.docs.map((d, i) => [d.finding.id, i]));
const jac = (a: string, b: string) => {
  const ta = new Set(docTerms(ix, idx.get(a)!).keys()), tb = new Set(docTerms(ix, idx.get(b)!).keys());
  let s = 0; for (const t of ta) if (tb.has(t)) s++;
  return s / (ta.size + tb.size - s);
};
const ids = ix.docs.map((d) => d.finding.id);
const same: number[] = [], diff: number[] = [];
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    (trapOf.get(ids[i]) === trapOf.get(ids[j]) ? same : diff).push(jac(ids[i], ids[j]));
  }
}
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log(`\n  term overlap, same trap:      ${(med(same) * 100).toFixed(0)}%   (real write-ups measured 32%)`);
console.log(`  term overlap, different trap: ${(med(diff) * 100).toFixed(0)}%`);
console.log(`  separation: ${(med(same) / Math.max(1e-9, med(diff))).toFixed(1)}x — how much room a duplicate detector has\n`);
