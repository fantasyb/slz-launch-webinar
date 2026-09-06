/**
 * Scaffolds a new finding with the next id, prefilled with the questions a
 * good finding has to answer.
 *
 *   npm run cairn:new -- "ripgrep exits 2 on literal braces"
 */
import fs from 'fs';
import path from 'path';
import { homePath } from '../src/lib/cairn/home';

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('usage: npm run cairn:new -- "<title>"');
  process.exit(2);
}

const DIR = homePath('cairn');
const existing = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

/*
 * The next id, collision-proof. The number is read from each finding's `id`
 * FIELD (cairn-NNNN), not sliced from the first four characters of the
 * filename — slice(0,4) silently truncates a five-digit id (cairn-10000 -> 1000)
 * and trusts the filename over the record, which is how a corpus can end up
 * minting the same number twice. We collect every number in use, take max+1,
 * then skip forward past any number already taken (a gap-filling manual id, a
 * race), so a fresh finding can never reuse or overwrite an existing id.
 */
const used = new Set<number>();
for (const f of existing) {
  let n = 0;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as { id?: unknown };
    const m = /^cairn-(\d+)$/.exec(String(j.id ?? ''));
    if (m) n = Number(m[1]);
  } catch { /* unreadable/corrupt: fall back to the filename below */ }
  if (!n) { const fm = /^(\d+)-/.exec(f); if (fm) n = Number(fm[1]); }
  if (n > 0) used.add(n);
}
let next = (used.size ? Math.max(...used) : 0) + 1;
while (used.has(next)) next++; // never collide with an id already in use
const num = String(next).padStart(4, '0');

// Belt and suspenders: refuse to write over a file whose numeric prefix is
// already taken, rather than silently clobbering someone's finding.
const clash = existing.find((f) => new RegExp(`^0*${next}-`).test(f));
if (clash) {
  console.error(`cairn:new: computed id cairn-${num} but ${clash} already uses it — refusing to overwrite. Re-run; the corpus may have changed under you.`);
  process.exit(1);
}
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const now = new Date().toISOString();

const template = {
  id: `cairn-${num}`,
  title,
  claim: 'TODO — one sentence, falsifiable. What is true, phrased so a specific observation would contradict it.',
  kind: 'trap',
  subject: { name: 'TODO', ecosystem: 'TODO', versions: '*' },
  // Default to the honest scope: you saw it fail in one place. Claim
  // 'universal' only with reason beyond a single run — it scores low until
  // confirmed in a second environment.
  scope: 'environment-specific',
  appliesTo: 'TODO — where this holds. Delete if you claim universal scope.',
  tags: [],
  cost: 'hours',
  expectation: 'TODO — what a competent reader would reasonably predict.',
  reality: 'TODO — what actually happens instead. The gap between this and expectation is the whole value.',
  mechanism: 'TODO — why it behaves that way, if known. Delete if not.',
  workaround: 'TODO — what to do instead. The part that saves the next agent an afternoon.',
  evidence: [{ command: 'TODO', output: 'TODO', note: 'optional' }],
  check: {
    command: 'TODO — cheap, hermetic, side-effect free.',
    confirmedIf: 'TODO',
    refutedIf: 'TODO',
    manual: false,
  },
  provenance: 'firsthand',
  halfLifeDays: 180,
  observations: [
    {
      at: now,
      by: 'TODO — your model or agent identifier',
      verdict: 'confirmed',
      note: 'TODO — what you saw. If you did not run it, set provenance to secondhand and say so here.',
      environment: {
        os: process.platform,
        arch: process.arch,
        runtime: `node ${process.version}`,
        note: 'TODO — anything else that would change the result',
      },
    },
  ],
  status: 'active',
  createdAt: now,
};

const file = path.join(DIR, `${num}-${slug}.json`);
fs.writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`);
console.log(`created ${path.relative(process.cwd(), file)}`);
console.log('\nFill in every TODO, then: npm run cairn:lint');
