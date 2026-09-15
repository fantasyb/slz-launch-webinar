/**
 * cairn:admit — is this one we already have?
 *
 *   npm run cairn:admit -- cairn/0032-my-new-finding.json
 *
 * THE RESOLVE STAGE, PUT WHERE IT CAN AFFORD TO RUN
 *
 * A warehouse ingests, RESOLVES identity, SEGMENTS, then activates. This
 * project had ingest and activate; segmentation now happens before ranking
 * (see SEGMENT_MIN_CORPUS), and this is resolution.
 *
 * It runs at write time rather than query time, and that is forced by a
 * measurement rather than chosen for convenience. Nine genuinely independent
 * write-ups of four traps were generated and compared against their originals:
 *
 *   real duplicates            26% - 36% term overlap, median 32%
 *   organic non-duplicate pairs  top of the real corpus is 27%
 *
 * The ranges OVERLAP. No lexical threshold separates a duplicate from two
 * findings that are merely about the same area -- 28% misses real duplicates,
 * 27% collapses cairn-0007 and cairn-0012, which are genuinely two records.
 * Automatic collapse at query time is therefore unsafe at every threshold, and
 * a query cannot afford the model call that would settle it.
 *
 * Write time can. It happens once per finding, on one record against the
 * corpus rather than every pair against every other, and nothing is signed
 * yet -- so a DUPLICATE verdict costs no re-signing, which is what makes
 * retroactive merging expensive.
 *
 * WHY A DUPLICATE SHOULD BECOME AN OBSERVATION
 *
 * Fifty people hitting the sandbox proxy should not produce fifty thin
 * records. It should produce one finding with fifty attesters, which is
 * exactly what this corpus already rewards: `confidence` rises with
 * confirmation, `scope: universal` has to be earned across environments, and
 * the linter warns when an empirical universal claim has been seen in fewer
 * than two. The duplicate is not waste -- it is the evidence that the finding
 * is real, arriving in the wrong shape.
 *
 * PROPOSES ONLY. Nothing is written. The submitter can disagree, and should
 * be able to: a wrong DUPLICATE silently loses a real finding, which is worse
 * than a wrong DISTINCT that merely costs a redundant record.
 */
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import { buildIndex, docTerms, tokenize } from '../src/lib/cairn/retrieval';
import { FindingSchema } from '../src/lib/cairn/schema';
import { proposeSurvivor } from '../src/lib/cairn/survivorship';
import type { Finding } from '../src/lib/cairn/schema';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: npm run cairn:admit -- <path/to/draft.json>');
  process.exit(2);
}

/*
 * OFFLINE MODE, and it is not a lesser version — it is the one that runs where
 * it matters most.
 *
 * Adjudication and the payoff check both call a model, which needs a key. A
 * pull request from a fork does not get repository secrets, and a fork is
 * exactly how somebody outside the team contributes their first finding. So
 * the half that needs no key — candidate generation by term overlap, measured
 * at 9/9 recall on independently written duplicates — runs regardless, and the
 * contributor is told which existing records look close and asked to judge.
 *
 * A near neighbour named and left to a human beats a verdict that never ran.
 */
const offline = process.argv.includes('--offline') || !process.env.ANTHROPIC_API_KEY;

const draft = FindingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) as Finding;
const corpus = loadCorpus().filter((f) => f.status !== 'retired' && f.id !== draft.id);

/*
 * Candidate generation by term overlap. Measured 9/9 recall on independently
 * written duplicates, carrying roughly three false candidates for each true
 * one -- which is the right side to err on when a model adjudicates next.
 */
const ix = buildIndex([...corpus, draft]);
const idx = new Map(ix.docs.map((d, i) => [d.finding.id, i]));
const termsOf = (id: string) => new Set(docTerms(ix, idx.get(id)!).keys());
const dt = termsOf(draft.id);
const scored = corpus.map((f) => {
  const tf = termsOf(f.id);
  let shared = 0;
  for (const t of dt) if (tf.has(t)) shared++;
  return { f, jac: shared / (dt.size + tf.size - shared) };
}).sort((a, b) => b.jac - a.jac);
const nearest = scored.slice(0, 5).filter((x) => x.jac > 0.15);

const brief = (f: Finding) =>
  `TITLE: ${f.title}\nCLAIM: ${f.claim}\nEXPECTED: ${f.expectation}\nACTUALLY: ${f.reality}` +
  (f.workaround ? `\nWORKAROUND: ${f.workaround}` : '');

const SYSTEM = `A new engineering finding is being submitted to a corpus of recorded traps. You are shown the submission and one existing record. Decide whether they describe the same underlying trap.

DUPLICATE — the same failure, same cause, same fix, written by a different person in different words. The submission should become an OBSERVATION on the existing record rather than a new one.

FACETS — one underlying trap with two genuinely distinct symptoms or moments of failure, each worth finding on its own. Accept the submission and link them.

DISTINCT — different traps. They may share a tool, a subject, or vocabulary and still be different failures. This is the common answer.

Bias toward DISTINCT. A wrong DUPLICATE silently discards a real finding and the person who wrote it never learns; a wrong DISTINCT costs one redundant record.

Reply exactly:
VERDICT: DUPLICATE|FACETS|DISTINCT
WHY: one sentence.`;

/*
 * THE PAYOFF STAGE
 *
 * Resolution above asks whether we already have this finding. This asks
 * whether having it will change anything, which is a different question and
 * was measured before it was added here. Across three traps and twenty-two
 * trials, agents queried the corpus unprompted, got the intended finding
 * ranked first, cited it by id -- and the arm without the corpus was equally
 * correct every time. A fourth trap, chosen because it shut both routes,
 * separated 0/5 against 5/5. That is cairn-0034.
 *
 * The two routes a reader can take around a recorded trap:
 *
 *   1. It is documented somewhere they have already read.
 *   2. They can derive it from evidence on the affected machine.
 *
 * A finding pays only when both are shut. This does not gate admission --
 * cairn-0034 says a locally-recoverable finding may still be worth keeping,
 * with its payoff measured as saved turns rather than as correctness. What it
 * does is tell the submitter which kind they have written, while the record is
 * still cheap to reshape.
 *
 * QUESTION 1 IS ABOUT REACH, NOT EXISTENCE, and it was rewritten after being
 * checked against the two findings whose trial outcomes are known. On the
 * first phrasing -- "where would someone already read this?" -- cairn-0005 came
 * back with both routes open and "expect it to change nothing", which matches
 * its measured 3/3 against 3/3. cairn-0019 came back citing CWE-807, "Reliance
 * on Untrusted Inputs in a Security Decision", and was downgraded to a cost
 * saving. It had measured 0/5 against 5/5.
 *
 * The citation was real and correct, and it did not matter. Every control trial
 * knew that principle in the abstract -- one of them called halfLifeDays "the
 * author's estimate" in the same answer that trusted it -- and none connected
 * it to the input in front of them. Documentation that exists but that the task
 * never prompts anyone to reach for leaves route one open in name only. So the
 * question asks whether the task raises the question, and abstract sources are
 * named in WHY rather than counted.
 *
 * IT ASKS FOR ARTEFACTS, NOT A VERDICT, and that is the rest of the design. "Do you
 * already know this?" is a self-report, and a model's answer to it is
 * confident in one direction regardless of the truth. A CITATION can be
 * checked. A COMMAND can be run. So the model is asked where the trap is
 * documented and what would expose it locally, and the submitter checks the
 * two answers rather than trusting the label attached to them.
 */
const PAYOFF = `You are shown a recorded engineering trap. Do not judge whether it is true or well written. Answer two questions about whether writing it down will change what a competent engineer or coding agent does.

1. DOCUMENTED — is there a source that someone DOING THE TASK IN WHICH THIS TRAP IS LIVE would be prompted to reach for? Name the specific manual, changelog, error message, or well-known write-up. A general principle that is documented in the abstract but that nobody looks up while doing this particular task does not count: answer NONE and name it in WHY instead. The test is whether the task itself raises the question, not whether an answer exists somewhere.

2. LOCAL — on a machine where this trap is live, what single command or observation would reveal it, without knowing it in advance? Give the command. If the failure is silent, or the evidence only appears long after the mistake, or reading it requires already suspecting the trap, say NONE.

Reply exactly:
DOCUMENTED: <source, or NONE>
LOCAL: <command, or NONE>
WHY: one sentence on the harder of the two, and name any abstract source you excluded under question 1.`;

async function payoff(client: Anthropic) {
  const res = await client.messages.create({
    model: 'claude-opus-5', max_tokens: 700, thinking: { type: 'adaptive' },
    system: PAYOFF,
    messages: [{ role: 'user', content: brief(draft) }],
  });
  const t = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const doc = /DOCUMENTED:\s*(.+)/i.exec(t)?.[1]?.trim() ?? 'NONE';
  const loc = /LOCAL:\s*(.+)/i.exec(t)?.[1]?.trim() ?? 'NONE';
  const why = /WHY:\s*(.+)/i.exec(t)?.[1]?.trim() ?? '';
  const shut = (x: string) => /^none\b/i.test(x);

  console.log('\n  PAYOFF — would recording this change what anyone does?\n');
  console.log(`  ${shut(doc) ? 'shut ' : 'OPEN '} documented   ${doc.slice(0, 84)}`);
  console.log(`  ${shut(loc) ? 'shut ' : 'OPEN '} recoverable  ${loc.slice(0, 84)}`);
  if (why) console.log(`         ${why.slice(0, 88)}`);

  if (shut(doc) && shut(loc)) {
    console.log('\n  Both routes shut. This is the kind that changed outcomes 5/5 in trials.');
  } else if (!shut(doc) && !shut(loc)) {
    console.log('\n  Neither route shut. Keep it if you like, but expect it to change nothing:');
    console.log('  a reader can look it up AND derive it. Measure saved turns, not correctness.');
  } else {
    console.log(`\n  One route open. Its payoff is a cost saving, not a correction -- measure it`);
    console.log('  in turns or wall clock, because a correctness comparison will show nothing.');
  }
  console.log('\n  Both answers are checkable and neither is authoritative: open the manual it');
  console.log('  named, or run the command it gave. A model asked what it already knows');
  console.log('  answers confidently either way, which is why it was asked for artefacts.');
}

async function main() {
  console.log(`\nADMITTING  ${draft.id}  ${draft.title.slice(0, 60)}`);
  console.log('='.repeat(72));
  if (offline) {
    if (nearest.length === 0) {
      console.log('\n  Nothing in the corpus is lexically close. Nobody has obviously');
      console.log('  recorded this already.\n');
      return;
    }
    console.log('\n  CLOSEST EXISTING RECORDS — no model available, so these are');
    console.log('  lexical neighbours and not a verdict. Read them before adding yours.\n');
    for (const { f, jac } of nearest) {
      console.log(`  ${((jac * 100).toFixed(0) + '%').padStart(4)} overlap  ${f.id}  ${f.title.slice(0, 62)}`);
    }
    console.log('\n  If one of these is the SAME trap, do not add a record: add an');
    console.log('  observation to it instead. One finding with fifty attesters is worth');
    console.log('  more than fifty thin records, and confidence and scope both key on');
    console.log('  exactly that. Run this with ANTHROPIC_API_KEY set for an adjudication.\n');
    return;
  }

  const client = new Anthropic();
  if (nearest.length === 0) {
    console.log('\n  Nothing in the corpus is close. ACCEPT as a new finding.');
    await payoff(client);
    console.log('');
    return;
  }
  const verdicts: Array<{ id: string; v: string; why: string; jac: number }> = [];
  for (const { f, jac } of nearest) {
    const res = await client.messages.create({
      model: 'claude-opus-5', max_tokens: 900, thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `--- SUBMISSION ---\n${brief(draft)}\n\n--- EXISTING (${f.id}) ---\n${brief(f)}` }],
    });
    const t = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    const v = /VERDICT:\s*(DUPLICATE|FACETS|DISTINCT)/i.exec(t)?.[1]?.toUpperCase() ?? 'DISTINCT';
    const why = /WHY:\s*(.+)/i.exec(t)?.[1]?.trim() ?? '';
    verdicts.push({ id: f.id, v, why, jac });
    console.log(`  ${v.padEnd(9)} vs ${f.id}  (${(jac * 100).toFixed(0)}% term overlap)`);
    if (v !== 'DISTINCT') console.log(`            ${why.slice(0, 90)}`);
  }

  const dup = verdicts.find((x) => x.v === 'DUPLICATE');
  const fac = verdicts.filter((x) => x.v === 'FACETS');
  console.log('');
  if (dup) {
    console.log(`  RECOMMEND: do not add a record. Add an observation to ${dup.id}.`);
    console.log(`\n  Suggested observation for ${dup.id}:\n`);
    /*
     * Carry the SUBMITTER'S own observation across, not the finding's prose.
     *
     * The first version used `draft.reality` and `draft.provenance`, which
     * produced an observation authored by "firsthand" -- a provenance enum --
     * quoting the record rather than the person. What is worth keeping from a
     * duplicate is the encounter: who hit it, where, and what they saw. The
     * record already exists.
     */
    const own = draft.observations?.[0];
    console.log(JSON.stringify({
      at: own?.at ?? new Date().toISOString(),
      by: own?.by ?? '<your agent id>',
      verdict: own?.verdict ?? 'confirmed',
      note: (own?.note ?? draft.reality).replace(/\s+/g, ' ').slice(0, 240),
      ...(own?.environment ? { environment: own.environment } : {}),
    }, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    console.log(`\n  That turns a duplicate into evidence: ${dup.id} gains an attester, and`);
    console.log('  confidence and scope both key on exactly that.');

    /*
     * And the rest of the submission is not thrown away.
     *
     * "Keep the observation, discard the record" is the crudest survivorship
     * rule there is, and at scale it loses real improvements: the fifty-first
     * person to hit a trap may have written the clearer title or captured
     * output nobody had. Master data management resolves this per FIELD --
     * union what must never be lost, take the safer value where two records
     * disagree, and hand genuinely subjective prose to a person.
     */
    const existing = corpus.find((f) => f.id === dup.id)!;
    const decisions = proposeSurvivor(existing, draft);
    if (decisions.length) {
      console.log(`\n  SURVIVORSHIP — what else ${dup.id} would gain:\n`);
      for (const d of decisions) {
        const head = `  ${d.rule.toUpperCase().padEnd(7)} ${d.field}`;
        if (d.rule === 'judged') {
          console.log(`${head}   A PERSON DECIDES`);
          console.log(`             existing: ${String(d.existing).replace(/\s+/g, ' ').slice(0, 74)}`);
          console.log(`             incoming: ${String(d.incoming).replace(/\s+/g, ' ').slice(0, 74)}`);
        } else {
          console.log(`${head} -> ${JSON.stringify(d.value).slice(0, 60)}`);
        }
        console.log(`             ${d.why.slice(0, 88)}`);
      }
    }
  } else if (fac.length) {
    console.log(`  RECOMMEND: accept, and link as facets of one trap with ${fac.map((x) => x.id).join(', ')}.`);
  } else {
    console.log('  RECOMMEND: accept as a new finding. Nothing here is the same trap.');
  }
  await payoff(client);
  console.log('\n  Nothing was written. Disagree and submit anyway if you were there.\n');
}
void main();
