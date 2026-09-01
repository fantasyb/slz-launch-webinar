/**
 * cairn:semantic-ceiling — is the residual a MEANING problem, or a LABEL problem?
 *
 *   ANTHROPIC_API_KEY=... npm run cairn:semantic-ceiling
 *
 * retrieval.ts asserts, in the four-walls comment, that the failures no
 * ranking approach could close turn on what a sentence ASSERTS rather than on
 * any statistic over its words -- and that closing them therefore needs
 * semantics. That was an inference from seventeen failed attempts, not a
 * measurement, and it sat in the code unfalsified.
 *
 * This falsifies it. For every case the retriever currently gets wrong, a
 * semantic reader is shown the query and the two competing findings, in
 * randomised order, with no indication which is gold and no access to the
 * retriever's opinion. If it separates them, the inference holds and the way
 * forward is semantic. If it does not, the inference was wrong.
 *
 * FIRST RESULT, 2026-09-01: 6 of 9.
 *
 * Semantics helps and does not close it, and the three it missed are the
 * useful part -- all were cairn-0007, and none of them are queries. One is
 * methodology commentary ("I did not run the install, precisely because doing
 * so is the failure mode"); another is about the commit-reveal protocol, which
 * is why the reader chose cairn-0023, "Commit-reveal proves when a forecast
 * was made". That is arguably the correct answer, and the gold label says
 * otherwise only because the note happens to live in cairn-0007's file.
 *
 * So part of the error floor this project has been reporting as retrieval
 * error is label noise. scripts/eval-audit.ts measures how much.
 *
 * A DIAGNOSTIC, NOT A GATE. It costs money, needs a key, and is not run by
 * cairn:guard. Nothing in the retriever depends on it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';
import { heldOutCases } from '../src/lib/cairn/evalset';

const all = loadCorpus();
const byId = new Map(all.map((f) => [f.id, f]));
const brief = (id: string) => {
  const f = byId.get(id)!;
  return `TITLE: ${f.title}\nCLAIM: ${f.claim}\nEXPECTED: ${f.expectation}\nACTUALLY: ${f.reality}`;
};

async function main() {
  const client = new Anthropic();
  let correct = 0, n = 0;

  for (const c of heldOutCases(all)) {
    const hits = retrieve(c.q, all);
    const r = hits.findIndex((h) => h.finding.id === c.gold);
    if (r === 0) continue;
    const winner = hits[0].finding.id;
    n++;
    // Randomise which is A and which is B, so position carries no signal.
    const flip = n % 2 === 0;
    const A = flip ? winner : c.gold;
    const B = flip ? c.gold : winner;

    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1200,
      thinking: { type: 'adaptive' },
      system:
        'You are shown a search query and two candidate engineering findings. ' +
        'Decide which finding the query is actually about. The query was written ' +
        'by somebody who had encountered one of these problems. ' +
        'Answer with exactly one character: A or B. Nothing else.',
      messages: [{
        role: 'user',
        content: `QUERY:\n${c.q}\n\n--- CANDIDATE A ---\n${brief(A)}\n\n--- CANDIDATE B ---\n${brief(B)}\n\nWhich is the query about? Answer A or B.`,
      }],
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text).join('').trim().toUpperCase();
    const picked = text.startsWith('A') ? A : text.startsWith('B') ? B : '?';
    const ok = picked === c.gold;
    if (ok) correct++;
    console.log(`  ${ok ? 'OK  ' : 'MISS'} gold ${c.gold} vs winner ${winner} -> picked ${picked}`);
  }
  console.log(`\n  semantic reader on the retriever's failures: ${correct}/${n}`);

}
void main();
