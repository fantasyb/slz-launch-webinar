/**
 * cairn:resolve — identity resolution over the corpus.
 *
 *   npm run cairn:resolve              propose, print a report, change nothing
 *   npm run cairn:resolve -- --json    machine-readable, for review tooling
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A RETRIEVAL FEATURE
 *
 * Eighteen ranking experiments were spent trying to separate cairn-0007
 * ("playwright install re-downloads browsers a sandbox already has") from
 * cairn-0012 ("Playwright's launch-time check tells you to run the command
 * that wastes the disk"). Every one failed, and the block comments in
 * retrieval.ts explain each failure in its own terms.
 *
 * The simpler explanation is that this was never a ranking problem. Those are
 * two records of ONE trap -- the launch check tells you to run the install,
 * and the install wastes the disk. A customer data platform would call that a
 * duplicate identity and resolve it; no ranking function has ever fixed a
 * duplicate record, which is why none of the eighteen could.
 *
 * The DELIVERY metric already half-admits this: it scores a sibling NAMING the
 * gold as a success, because ranking was known to be the wrong question before
 * anybody said so.
 *
 * THREE VERDICTS, BECAUSE MERGING IS EXPENSIVE AND LINKING IS FREE
 *
 *   DUPLICATE  the same trap recorded twice. Merge, and pay the cost below.
 *   FACETS     one trap, two symptoms worth stating separately. Link hard.
 *   DISTINCT   adjacent, genuinely different. Leave alone.
 *
 * WHAT IT FOUND HERE, WHICH REFUTES THE HYPOTHESIS THAT PROMPTED IT
 *
 * 23 candidate pairs, including all three measured confusions, adjudicated
 * with a bias toward DISTINCT:
 *
 *   0 duplicate, 1 facets, 22 distinct
 *   merging the duplicates would move held-out P@1 0.864 -> 0.864
 *
 * So the sibling residual is NOT a duplicate-identity problem. That was the
 * appealing explanation -- eighteen ranking experiments failed, and a customer
 * data platform would have called those pairs duplicate records rather than a
 * ranking failure -- and it is wrong. These findings really are distinct
 * traps; they are simply hard to tell apart from a short query, which is the
 * conclusion the four-walls comment in retrieval.ts already reached the long
 * way around.
 *
 * The one FACETS pair is cairn-0007 and cairn-0012, on the reasoning that
 * Playwright resolves browsers by pinned revision rather than by presence, so
 * the launch-time check and the install are two symptoms of one mechanism.
 * They are already linked -- measured confusion puts each in the other's
 * disclosure -- so even that verdict asks for nothing new.
 *
 * The tool stays because the answer will change. A corpus with one contributor
 * cannot have duplicate records; a corpus with fifty will, and by then the
 * question is expensive to ask by hand.
 *
 * NOTHING IS MUTATED. A merge rewrites a finding's body, which changes
 * findingBodyHash, which invalidates every observation signature on both
 * findings and every sealed forecast bound to them. That is a corpus surgery
 * with a re-signing step and a human decision, not something a script should
 * do because a model said SAME. This proposes and simulates; a person merges.
 */
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve, buildIndex, docTerms, confusionPairs } from '../src/lib/cairn/retrieval';
import { heldOutCases } from '../src/lib/cairn/evalset';
import type { Finding } from '../src/lib/cairn/schema';

const all = loadCorpus().filter((f) => f.status !== 'retired');
const byId = new Map(all.map((f) => [f.id, f]));
const ix = buildIndex(all);
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/*
 * CANDIDATE GENERATION — deterministic rules first, as a CDP does.
 *
 * Three independent reasons to suspect two records are one entity. Each is
 * cheap, and a pair flagged by more than one is a stronger candidate; the
 * point is recall, since the adjudicator below rejects freely.
 */
const idx = new Map(ix.docs.map((d, i) => [d.finding.id, i]));
const termsOf = (id: string) => new Set(docTerms(ix, idx.get(id)!).keys());
const confusions = confusionPairs(all);

interface Candidate { a: string; b: string; reasons: string[]; overlap: number }
const allJac: number[] = [];
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const ta = termsOf(all[i].id), tb = termsOf(all[j].id);
    let sh = 0;
    for (const t of ta) if (tb.has(t)) sh++;
    allJac.push(sh / (ta.size + tb.size - sh));
  }
}
allJac.sort((a, b) => b - a);
const threshold = allJac[Math.floor(allJac.length * 0.05)] ?? 1;
const candidates: Candidate[] = [];
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const A = all[i], B = all[j];
    const reasons: string[] = [];
    // 1. MEASURED: retrieval itself cannot tell them apart.
    if ((confusions.get(A.id) ?? []).includes(B.id) || (confusions.get(B.id) ?? []).includes(A.id)) {
      reasons.push('measured confusion');
    }
    // 2. DECLARED: same subject, which is the corpus's own identity field.
    if (A.subject.name.toLowerCase() === B.subject.name.toLowerCase()) reasons.push('same subject');
    // 3. LEXICAL: Jaccard over indexed terms.
    const ta = termsOf(A.id), tb = termsOf(B.id);
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    const jac = shared / (ta.size + tb.size - shared);
    // Relative, not absolute: doc-to-doc Jaccard tops out at 27% in this
    // corpus, so any fixed threshold is a guess about corpus shape. The top
    // 5% of pairs is a statement about THIS corpus whatever its scale.
    if (jac >= threshold) reasons.push(`term overlap ${(jac * 100).toFixed(0)}%`);
    if (reasons.length) candidates.push({ a: A.id, b: B.id, reasons, overlap: jac });
  }
}
candidates.sort((x, y) => y.reasons.length - x.reasons.length || y.overlap - x.overlap);

const brief = (f: Finding) =>
  `TITLE: ${f.title}\nCLAIM: ${f.claim}\nEXPECTED: ${f.expectation}\nACTUALLY: ${f.reality}` +
  (f.workaround ? `\nWORKAROUND: ${f.workaround}` : '');

const SYSTEM = `You are resolving identity in a corpus of engineering findings — recorded traps that cost somebody time. Two records are shown. Decide whether they describe the same underlying trap.

DUPLICATE — the same trap, recorded twice. One record should exist. Different wording, same failure, same cause, same fix.

FACETS — ONE underlying trap that genuinely has two distinct symptoms or two distinct moments of failure, each worth its own record so a searcher hitting either symptom finds it. Cause-and-effect pairs belong here.

DISTINCT — different traps. They may share a subject, a tool, or vocabulary and still be different failures with different causes or different fixes. This is the common answer and the safe one.

Bias toward DISTINCT. Merging is destructive and irreversible here; a wrong DUPLICATE costs a real record.

Reply with exactly two lines:
VERDICT: DUPLICATE|FACETS|DISTINCT
WHY: one sentence, naming the shared cause if there is one.`;

async function main() {
  console.log(`\n  ${candidates.length} candidate pairs from ${all.length} findings\n`);
  const client = new Anthropic();
  const verdicts: Array<Candidate & { verdict: string; why: string }> = [];
  for (const c of candidates) {
    const res = await client.messages.create({
      model: 'claude-opus-5', max_tokens: 900, thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content:
        `--- RECORD 1 (${c.a}) ---\n${brief(byId.get(c.a)!)}\n\n--- RECORD 2 (${c.b}) ---\n${brief(byId.get(c.b)!)}` }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    const verdict = /VERDICT:\s*(DUPLICATE|FACETS|DISTINCT)/i.exec(text)?.[1]?.toUpperCase() ?? 'DISTINCT';
    const why = /WHY:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
    verdicts.push({ ...c, verdict, why });
    const mark = verdict === 'DUPLICATE' ? '!!' : verdict === 'FACETS' ? ' >' : '  ';
    console.log(`  ${mark} ${verdict.padEnd(9)} ${c.a} / ${c.b}  [${c.reasons.join(', ')}]`);
    if (verdict !== 'DISTINCT') console.log(`               ${why.slice(0, 92)}`);
  }

  const dup = verdicts.filter((v) => v.verdict === 'DUPLICATE');
  const fac = verdicts.filter((v) => v.verdict === 'FACETS');
  console.log(`\n  ${dup.length} duplicate, ${fac.length} facets, ${verdicts.length - dup.length - fac.length} distinct`);

  /*
   * SIMULATION, NOT MUTATION. If the proposed duplicates were one record, how
   * many held-out failures would stop being failures? A merged pair cannot be
   * ranked wrongly against itself, so this is an upper bound on what merging
   * would buy -- and the number to weigh against a re-signing.
   */
  const merged = new Map<string, string>();
  for (const v of dup) merged.set(v.b, v.a);
  const canon = (id: string) => merged.get(id) ?? id;
  let p1 = 0, p1After = 0, n = 0;
  for (const c of heldOutCases(all)) {
    const top = retrieve(c.q, all)[0]?.finding.id;
    if (!top) { n++; continue; }
    n++;
    if (top === c.gold) { p1++; p1After++; }
    else if (canon(top) === canon(c.gold)) p1After++;
  }
  console.log(`\n  held-out P@1 now:            ${(p1 / n).toFixed(3)}`);
  console.log(`  if the duplicates merged:    ${(p1After / n).toFixed(3)}   (upper bound)`);
  console.log(`\n  Nothing was modified. Merging rewrites a finding body, which invalidates`);
  console.log(`  every observation signature and sealed forecast on both records.\n`);

  if (asJson) fs.writeFileSync('resolve-report.json', `${JSON.stringify(verdicts, null, 2)}\n`);
}
void main();
