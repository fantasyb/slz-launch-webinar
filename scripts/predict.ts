/**
 * SEAL a forecast. Phase one of commit-reveal.
 *
 *   CAIRN_AGENT=my-agent npm run cairn:predict -- cairn-0007 0.85 "reasoning"
 *
 * Writes a commitment (a hash) into the finding, and the secret preimage into
 * .cairn-secrets/, which is gitignored. You then COMMIT AND PUSH the seal
 * before running the check. That published commit is what proves the forecast
 * preceded its own adjudication.
 *
 * Prints the claim and the check command and nothing else: no evidence, no
 * prior observations, no other predictions.
 */
import fs from 'fs';
import { resolveFindingFile } from '../src/lib/cairn/resolve';
import path from 'path';
import { execSync } from 'child_process';
import { FindingSchema } from '../src/lib/cairn/schema';
import { computeCommitment, generateNonce } from '../src/lib/cairn/commitment';
import { writeJsonAtomic } from '../src/lib/cairn/atomic';
import { findingBodyHash } from '../src/lib/cairn/signing';
import { homePath } from '../src/lib/cairn/home';

const [id, priorArg, ...reasoningParts] = process.argv.slice(2);
const agent = process.env.CAIRN_AGENT;

if (!id) {
  console.error('usage: CAIRN_AGENT=<you> npm run cairn:predict -- <cairn-NNNN> [prior] [reasoning]');
  process.exit(2);
}

const DIR = homePath('cairn');
let full: string;
try {
  full = resolveFindingFile(id, DIR);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
const f = FindingSchema.parse(raw);

// --- blinded view ---------------------------------------------------------
console.log(`\n${f.id} — ${f.title}\n`);
console.log(`subject: ${f.subject.name} (${f.subject.ecosystem}), versions ${f.subject.versions}`);
console.log(`scope:   ${f.scope}${f.appliesTo ? ` — ${f.appliesTo}` : ''}\n`);
console.log(`CLAIM\n  ${f.claim}\n`);
console.log(`CHECK\n  $ ${f.check.command}\n`);
console.log(`  confirmed if: ${f.check.confirmedIf}`);
console.log(`  refuted if:   ${f.check.refutedIf}\n`);
console.log('Evidence, observations and other forecasts are withheld by design.\n');

if (!priorArg) {
  console.log('To seal a forecast:\n');
  console.log(`  CAIRN_AGENT=<you> npm run cairn:predict -- ${f.id} 0.75 "your reasoning"\n`);
  process.exit(0);
}

if (!agent) {
  console.error('CAIRN_AGENT must be set to seal a forecast.');
  process.exit(2);
}
const prior = Number(priorArg);
if (!Number.isFinite(prior) || prior < 0 || prior > 1) {
  console.error('prior must be a number between 0 and 1');
  process.exit(2);
}
const reasoning = reasoningParts.join(' ').trim();
if (reasoning.length < 20) {
  console.error('reasoning is required, and is the part worth training on. Be specific.');
  process.exit(2);
}
if (f.predictions.some((p) => p.by === agent)) {
  console.error(`${agent} has already sealed a forecast on ${f.id}.`);
  process.exit(2);
}

const anchor = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const nonce = generateNonce();
const hash = computeCommitment({ findingId: f.id, by: agent, priorConfirmed: prior, reasoning, anchor, nonce });

// Private first, public second, and the order is load-bearing.
//
// A preimage with no published seal is worthless — nobody can be held to a
// commitment that was never announced, and the next `cairn:predict` simply
// overwrites it. A published seal with no preimage is unrecoverable: reveal
// refuses ("no sealed forecast found") and predict refuses to seal twice, so
// the forecast is stuck `sealed` forever and looks identical to an honest
// pending one. Writing the corpus first put the unrecoverable failure on the
// likelier path.
const secretDir = homePath('.cairn-secrets');
fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
const secretFile = path.join(secretDir, `${f.id}--${agent.replace(/[^\w.-]/g, '_')}.json`);
// 0600: until reveal, the confidentiality of this file is the entire blind.
writeJsonAtomic(
  secretFile,
  { findingId: f.id, by: agent, priorConfirmed: prior, reasoning, anchor, nonce, hash },
  0o600,
);

// Public: the seal only.
raw.predictions = [
  ...raw.predictions,
  {
    at: new Date().toISOString(),
    by: agent,
    commitment: { algorithm: 'sha256', hash, anchor },
    bodyHash: findingBodyHash(f),
    self: false,
  },
];
writeJsonAtomic(full, raw);

console.log(`SEALED  ${hash.slice(0, 16)}…  anchored at ${anchor.slice(0, 10)}`);
console.log(`secret  ${path.relative(process.cwd(), secretFile)} (gitignored)\n`);
console.log('Now publish the seal BEFORE running the check:\n');
console.log(`  git add cairn/${path.basename(full)} && git commit -m "seal: forecast on ${f.id}" && git push\n`);
console.log('Then run the check, record what it did, and reveal:\n');
console.log(`  npm run cairn:verify ${f.id}`);
console.log(`  CAIRN_KEY=<id> CAIRN_AGENT=${agent} npm run cairn:observe -- ${f.id} <confirmed|refuted> "what you saw"`);
console.log(`  CAIRN_AGENT=${agent} npm run cairn:reveal -- ${f.id}`);
console.log('\nThe outcome is derived from the observations, not supplied by you,');
console.log('and only observations recorded after the seal can resolve it.');
