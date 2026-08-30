/**
 * REVEAL a sealed forecast. Phase two of commit-reveal.
 *
 *   CAIRN_AGENT=my-agent npm run cairn:reveal -- cairn-0007 confirmed
 *
 * Reads the local preimage, writes the prior, reasoning and nonce into the
 * finding, and refuses if the recomputed hash does not match the published
 * seal. A revealed prediction that does not recompute is marked broken and
 * never scored.
 */
import fs from 'fs';
import { resolveFindingFile } from '../src/lib/cairn/resolve';
import path from 'path';
import { FindingSchema } from '../src/lib/cairn/schema';
import { computeCommitment, commitmentStatus } from '../src/lib/cairn/commitment';
import { derivedVerdict } from '../src/lib/cairn/decay';

const [id] = process.argv.slice(2);
const agent = process.env.CAIRN_AGENT;

if (!id || !agent) {
  console.error('usage: CAIRN_AGENT=<you> npm run cairn:reveal -- <cairn-NNNN>');
  process.exit(2);
}
// The outcome is NOT an argument. It is derived from the finding's own
// observations, because a forecast scored against a number its own forecaster
// typed measures nothing.

const DIR = path.join(process.cwd(), 'cairn');
let full: string;
try {
  full = resolveFindingFile(id, DIR);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
const f = FindingSchema.parse(raw);

const secretFile = path.join(process.cwd(), '.cairn-secrets', `${f.id}--${agent.replace(/[^\w.-]/g, '_')}.json`);
if (!fs.existsSync(secretFile)) {
  console.error(`no sealed forecast found at ${path.relative(process.cwd(), secretFile)}`);
  console.error('A forecast can only be revealed by whoever sealed it.');
  process.exit(2);
}
const secret = JSON.parse(fs.readFileSync(secretFile, 'utf8'));

const idx = raw.predictions.findIndex(
  (p: { by: string; commitment?: { hash: string } }) =>
    p.by === agent && p.commitment?.hash === secret.hash,
);
if (idx === -1) {
  console.error('no matching published seal in the finding. Was the seal committed?');
  process.exit(2);
}

const recomputed = computeCommitment({
  findingId: f.id,
  by: agent,
  priorConfirmed: secret.priorConfirmed,
  reasoning: secret.reasoning,
  anchor: secret.anchor,
  nonce: secret.nonce,
});
if (recomputed !== secret.hash) {
  console.error('SEAL BROKEN: the local preimage does not reproduce the published hash.');
  console.error('Refusing to write. Nothing about this forecast can be trusted.');
  process.exit(1);
}

// Scored only against evidence recorded after the seal. A forecast is a claim
// about what a check will show, so the finding's pre-existing observations
// cannot resolve it — counting them let predict-then-reveal, with no check run
// at all, print a Brier score against the finding's own founding observation.
const sealedAt = new Date(raw.predictions[idx].at);
const outcome = derivedVerdict(f, { since: sealedAt });
if (outcome === 'inconclusive') {
  console.error(`${f.id} has no observation recorded since your seal at ${raw.predictions[idx].at}.`);
  console.error('Run the check and record what it did:');
  console.error(`  npm run cairn:verify ${f.id}`);
  console.error('A forecast cannot be resolved against evidence that predates it.');
  process.exit(2);
}

raw.predictions[idx] = {
  ...raw.predictions[idx],
  revealedAt: new Date().toISOString(),
  nonce: secret.nonce,
  priorConfirmed: secret.priorConfirmed,
  reasoning: secret.reasoning,
  outcome,
  resolvedAt: new Date().toISOString(),
};
fs.writeFileSync(full, `${JSON.stringify(raw, null, 2)}\n`);

const status = commitmentStatus(f.id, raw.predictions[idx]);
console.log(`\nREVEALED  ${f.id}  by ${agent}`);
console.log(`  prior     ${secret.priorConfirmed}`);
console.log(`  outcome   ${outcome}`);
console.log(`  seal      ${status}`);
if (status !== 'verified') {
  console.error('\nThe published hash does not recompute. This will not be scored.');
  process.exit(1);
}
const err = Math.abs(secret.priorConfirmed - (outcome === 'confirmed' ? 1 : 0));
console.log(`  brier     ${(err * err).toFixed(4)}`);
console.log('\nCommit the reveal. Anyone can now recompute the hash and confirm');
console.log('the forecast was sealed before the check ran.');
