/**
 * cairn:eval-audit — how much of the held-out set is not actually a query?
 *
 *   ANTHROPIC_API_KEY=... npm run cairn:eval-audit
 *
 * The held-out split is observation notes and prediction reasoning. Most of
 * those describe an encounter with a trap, which is what a query looks like.
 * Some describe how the observation was MADE -- the forecast was sealed first,
 * the check was asserted from documentation rather than run, the signature
 * covers these fields. Those are commentary about this project's own
 * record-keeping, and scoring retrieval against them measures nothing: there
 * is no technical failure in the text to retrieve a finding about.
 *
 * scripts/semantic-ceiling.ts is what surfaced this. A semantic reader failed
 * three of nine residual cases, and all three were notes of that kind -- on
 * one, the reader's "wrong" answer was arguably the right one.
 *
 * WHY THIS CANNOT QUIETLY FLATTER THE NUMBERS
 *
 * Dropping hard cases is exactly how a benchmark gets faked, so the classifier
 * is given as little as possible to cheat with: the note text alone. It never
 * sees the corpus, never learns which finding the note belongs to, and never
 * learns whether the retriever handled it. It cannot select for cases we get
 * right, because it is never told which those are.
 *
 * It is still a MODEL-CURATED filter, and any number derived from it must be
 * reported alongside the unfiltered one and labelled as such. A smaller number
 * on a cleaner split is only worth having if both are visible.
 *
 * A DIAGNOSTIC, NOT A GATE. Costs money, needs a key, not run by cairn:guard.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { loadCorpus } from '../src/lib/cairn/load';
import { heldOutCases } from '../src/lib/cairn/evalset';

async function main() {
  const all = loadCorpus();
  const cases = heldOutCases(all);
  const client = new Anthropic();
  const verdicts: Record<string, string> = {};
  let subject = 0, process_ = 0;

  for (const c of cases) {
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 600,
      system:
        'You classify short engineering notes. Answer with exactly one word.\n\n' +
        'SUBJECT — the note describes a technical problem, symptom, error or ' +
        'behaviour: something a person could search for because they hit it.\n\n' +
        'PROCESS — the note describes how an observation was made, verified, ' +
        'forecast, signed or recorded: commentary about methodology or about a ' +
        'record-keeping protocol, not about a technical failure.\n\n' +
        'Answer SUBJECT or PROCESS.',
      messages: [{ role: 'user', content: c.q }],
    });
    const t = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text).join('').trim().toUpperCase();
    const v = t.startsWith('PROCESS') ? 'PROCESS' : 'SUBJECT';
    verdicts[`${c.gold}|${c.q.slice(0, 60)}`] = v;
    if (v === 'PROCESS') { process_++; console.log(`  PROCESS  ${c.gold}: ${c.q.slice(0, 88).replace(/\s+/g, ' ')}`); }
    else subject++;
  }
  fs.writeFileSync('/tmp/claude-0/-home-user-slz-launch-webinar/cd16b2bc-8949-542b-a8aa-9cadcf6e0c44/scratchpad/verdicts.json', JSON.stringify(verdicts, null, 1));
  console.log(`\n  SUBJECT ${subject}   PROCESS ${process_}   of ${cases.length}`);
}
void main();
