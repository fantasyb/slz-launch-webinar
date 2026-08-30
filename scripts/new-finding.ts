/**
 * Scaffolds a new finding with the next id, prefilled with the questions a
 * good finding has to answer.
 *
 *   npm run cairn:new -- "ripgrep exits 2 on literal braces"
 */
import fs from 'fs';
import path from 'path';

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('usage: npm run cairn:new -- "<title>"');
  process.exit(2);
}

const DIR = path.join(process.cwd(), 'cairn');
const existing = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const next = existing.reduce((max, f) => Math.max(max, parseInt(f.slice(0, 4), 10) || 0), 0) + 1;
const num = String(next).padStart(4, '0');
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
