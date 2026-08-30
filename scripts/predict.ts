/**
 * Record a forecast BEFORE running a finding's check.
 *
 *   npm run cairn:predict cairn-0003
 *
 * This prints the claim and the check command and nothing else. It
 * deliberately withholds the evidence, the prior observations and everyone
 * else's predictions, because an unblinded forecast measures reading
 * comprehension rather than knowledge, and is worth close to zero.
 *
 * The blinding is the entire reason this data cannot be scraped: it requires
 * commitment in advance, adjudicated by execution.
 */
import fs from 'fs';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';

const id = process.argv[2];
const prior = process.argv[3];
if (!id) {
  console.error('usage: npm run cairn:predict <cairn-NNNN> [prior 0..1]');
  process.exit(2);
}

const DIR = path.join(process.cwd(), 'cairn');
const file = fs.readdirSync(DIR).find((f) => f.includes(id.replace('cairn-', '')));
if (!file) {
  console.error(`no finding matching ${id}`);
  process.exit(2);
}
const f = FindingSchema.parse(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')));

if (f.predictions.some((p) => p.by === process.env.CAIRN_AGENT)) {
  console.error(`${process.env.CAIRN_AGENT} has already predicted on ${f.id}.`);
  process.exit(2);
}

// --- blinded view ---------------------------------------------------------
console.log(`\n${f.id} — ${f.title}\n`);
console.log(`subject: ${f.subject.name} (${f.subject.ecosystem}), versions ${f.subject.versions}`);
console.log(`scope:   ${f.scope}${f.appliesTo ? ` — ${f.appliesTo}` : ''}\n`);
console.log(`CLAIM\n  ${f.claim}\n`);
console.log(`CHECK\n  $ ${f.check.command}\n`);
console.log(`  confirmed if: ${f.check.confirmedIf}`);
console.log(`  refuted if:   ${f.check.refutedIf}\n`);
console.log('Evidence, prior observations and other predictions are withheld.');
console.log('Forecast from what you know, not from what this file already says.\n');

if (!prior) {
  console.log('Re-run with your prior to record it:\n');
  console.log(`  npm run cairn:predict ${f.id} -- 0.75\n`);
  process.exit(0);
}

const value = Number(prior);
if (!Number.isFinite(value) || value < 0 || value > 1) {
  console.error('prior must be a number between 0 and 1');
  process.exit(2);
}

console.log('Append to the finding\'s `predictions` array, then run cairn:verify:\n');
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      by: process.env.CAIRN_AGENT ?? '<your model or agent identifier>',
      priorConfirmed: value,
      reasoning: '<why — the reasoning is the part worth training on, not the number>',
      blind: true,
    },
    null,
    2,
  ),
);
console.log('\nDo not revise it after seeing the result. A forecast edited to');
console.log('match the outcome destroys the only thing that makes it valuable.');
