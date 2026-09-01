/**
 * cairn:expand — generate the queries an agent would actually type.
 *
 *   ANTHROPIC_API_KEY=... npm run cairn:expand -- --limit 3   # cheap trial
 *   ANTHROPIC_API_KEY=... npm run cairn:expand                # all findings
 *   npm run cairn:expand -- --dry-run                         # print a prompt, call nothing
 *
 * WHY THIS EXISTS
 *
 * Every residual retrieval failure in this project is the same shape: an agent
 * describes an ENCOUNTER ("who writes this, and what would they gain by
 * lying") and the author wrote a FINDING ("a rule that reads a value from the
 * party it constrains"). Same event, near-disjoint vocabulary. Seventeen
 * ranking approaches failed on it, and the block comment in retrieval.ts
 * explains why none of them could work: the difference is what the sentences
 * MEAN, and no statistic over the words can see it.
 *
 * The standard fix is semantic similarity, which means embeddings and a model
 * at query time -- a dependency this project deliberately does not take, and
 * one that fails exactly when cairn is most needed, since an agent stuck
 * behind an allowlist proxy cannot reach an embedding API.
 *
 * So the semantics are moved to BUILD time instead. A model reads each finding
 * and writes the queries somebody would plausibly arrive with; those are
 * indexed alongside it. The consumer runs no model, makes no network call, and
 * gets a lexical index that already contains the searcher's vocabulary. This
 * is doc2query / docTTTTTquery, which is established IR practice rather than
 * anything invented here.
 *
 * WHY IT SUITS THIS PROJECT SPECIFICALLY
 *
 *   - Query time is unchanged: no model, no vectors, no cold start.
 *   - The artefact is TEXT, not floats, so it commits to git, a human can read
 *     and delete a bad line, and the signed-index fingerprint keeps working
 *     without worrying about cross-platform float drift.
 *   - It ships through machinery that already exists: the columnar index, the
 *     signature, the fingerprint gate.
 *   - It lands in the weak field tier, so a generated line can add weight to a
 *     finding without ever outranking the finding's own account of itself.
 *
 * EVAL INTEGRITY — THE PART THAT MATTERS MOST
 *
 * The held-out set is `observations[].note` and `predictions[].reasoning`.
 * THE MODEL IS NEVER SHOWN EITHER. It sees only fields that are already
 * indexed, so it cannot copy the text it will be scored against. That is
 * enforced below by construction rather than by intention: the prompt is built
 * from an explicit allow-list of fields, so adding a field to the corpus
 * cannot silently leak it into the prompt.
 *
 * The second rule has no code to enforce it and matters just as much: generate
 * ONCE with a considered prompt, then measure. Regenerating with a tweaked
 * prompt until held-out P@1 improves is fitting the corpus to the eval set
 * through a slower channel, and it would be undetectable afterwards.
 */
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import type { Finding } from '../src/lib/cairn/schema';

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const limit = Number(arg('limit') ?? 0);
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');

const OUT = path.join(process.cwd(), 'data', 'expansions.json');
const MODEL = 'claude-opus-5';
/** Per finding. Enough to cover distinct phrasings, few enough to stay signal. */
const WANTED = 8;

interface Store {
  _comment: string[];
  generatedAt: string;
  model: string;
  expansions: Record<string, string[]>;
}

/**
 * The ONLY fields the model may see.
 *
 * An explicit allow-list, not a deny-list. `observations` and `predictions`
 * are the held-out evaluation set, and a deny-list would leak them the moment
 * somebody renamed a field.
 */
export function visibleToModel(f: Finding): string {
  return [
    `TITLE: ${f.title}`,
    `CLAIM: ${f.claim}`,
    `SUBJECT: ${f.subject.name} (${f.subject.ecosystem}) ${f.subject.versions}`,
    `TAGS: ${f.tags.join(', ')}`,
    `EXPECTED: ${f.expectation}`,
    `ACTUALLY: ${f.reality}`,
    f.workaround ? `WORKAROUND: ${f.workaround}` : '',
    `CHECK: ${f.check.command}`,
    f.mechanism ? `WHY: ${f.mechanism}` : '',
    f.appliesTo ? `WHERE: ${f.appliesTo}` : '',
    ...(f.evidence ?? []).map((e) => `EVIDENCE: ${e.command ?? ''} => ${e.output ?? ''}`),
  ].filter(Boolean).join('\n');
}

const SYSTEM = `You write search queries for a corpus of engineering findings — recorded traps, limitations and dead ends that cost somebody real time.

Given one finding, write the queries a person or coding agent would plausibly arrive with WHEN THEY HAVE JUST HIT THIS AND DO NOT YET KNOW WHAT IT IS. That is the whole task, and the emphasis matters: someone mid-failure does not know the finding's title, its vocabulary, or its explanation. They know what they saw.

Write a spread across these kinds:
- the raw error text or command output, as it would be pasted from a terminal
- a plain description of the symptom, in ordinary words, with no jargon
- the wrong theory somebody would form first, phrased as what they would search
- the question they would ask a colleague
- the abstract shape of the problem, without any of this finding's specific nouns

Rules:
- Never use the finding's title as a query, or paraphrase it closely. A searcher who could write the title would already have found it.
- Prefer the searcher's words over the author's. If the finding says "allowlist proxy", a searcher says "connection refused" or "is the host down".
- Keep each query under 20 words. Some should be 3 or 4.
- No numbering, no commentary, no markdown.

Return ONLY a JSON array of ${WANTED} strings.`;

function parseQueries(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && s.length < 200);
  } catch {
    return [];
  }
}

async function main() {
  const all = loadCorpus().filter((f) => f.status !== 'retired');
  const targets = limit > 0 ? all.slice(0, limit) : all;

  if (dryRun) {
    console.log('=== SYSTEM ===\n' + SYSTEM);
    console.log('\n=== USER (first finding) ===\n' + visibleToModel(targets[0]));
    console.log(`\n${targets.length} findings would be sent. Nothing was called.`);
    return;
  }

  let store: Store;
  try {
    store = JSON.parse(fs.readFileSync(OUT, 'utf8')) as Store;
  } catch {
    store = {
      _comment: [
        'GENERATED. Queries a searcher might arrive with, written by a model at',
        'build time and indexed as weak-tier text so they can add weight to a',
        'finding without outranking its own account of itself.',
        '',
        'Committed deliberately: this is the artefact that makes the approach',
        'auditable. Read them. Delete a line that is wrong — nothing regenerates',
        'it unless you pass --force, and the index rebuilds from what is here.',
        '',
        'The generator never sees observations[].note or predictions[].reasoning.',
        'Those are the held-out evaluation set. See scripts/expand.ts.',
      ],
      generatedAt: '',
      model: MODEL,
      expansions: {},
    };
  }

  const client = new Anthropic();
  let done = 0;
  for (const f of targets) {
    if (!force && store.expansions[f.id]?.length) continue;
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: visibleToModel(f) }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const queries = parseQueries(text);
    if (queries.length === 0) {
      console.error(`  ${f.id}: no queries parsed — left untouched`);
      continue;
    }
    store.expansions[f.id] = queries;
    done++;
    console.log(`  ${f.id}  ${queries.length} queries`);
  }

  store.generatedAt = new Date().toISOString();
  store.model = MODEL;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(store, null, 2)}\n`);
  console.log(`\n${done} findings expanded, written to data/expansions.json`);
  console.log('Read them before committing. Then: npm run cairn:quick -- --folds 5');
}

if (process.env.CAIRN_EXPAND_IMPORT !== '1') void main();
