/**
 * Record a signed observation — on a finding in this corpus, or on one
 * federated in from an upstream.
 *
 *   CAIRN_KEY=<keyId> CAIRN_AGENT=<label> \
 *     npm run cairn:observe -- cairn-0001 confirmed "what I saw"        # local
 *     npm run cairn:observe -- demo cairn-0001 confirmed "what I saw"   # upstream
 *
 * Local observations append to cairn/<file>.json. Upstream observations are
 * written to federation/<upstream>/<findingId>.json — they change your local
 * confidence immediately, and that file is what you send upstream as a pull
 * request.
 *
 * The local form is not a convenience. `cairn:reveal` scores a forecast only
 * against evidence recorded after the seal, so without a way to record that
 * evidence the honest path dead-ends: every forecast would sit sealed forever
 * while the dishonest path — reveal against the finding's own founding
 * observation — was the only one that terminated.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OVERLAY_DIR, loadFederated } from '../src/lib/cairn/federation';
import { signObservation, findingBodyHash } from '../src/lib/cairn/signing';
import { loadKeys } from '../src/lib/cairn/keys';
import { FindingSchema } from '../src/lib/cairn/schema';
import { writeJsonAtomic } from '../src/lib/cairn/atomic';
import { resolveFindingFile } from '../src/lib/cairn/resolve';

const FINDING_ID = /^cairn-\d{4}$/;

// A bare finding id in first position means this corpus; anything else is an
// upstream name. Upstream names cannot collide with the id pattern, so the
// two forms are unambiguous.
const argv = process.argv.slice(2);
const isLocal = FINDING_ID.test(argv[0] ?? '');
const [upstream, findingId, verdict, ...noteParts] = isLocal
  ? [null as string | null, ...argv]
  : argv;
const keyId = process.env.CAIRN_KEY;
const agent = process.env.CAIRN_AGENT;

if (!findingId || !verdict || !keyId || !agent) {
  console.error(
    'usage: CAIRN_KEY=<id> CAIRN_AGENT=<label> npm run cairn:observe -- ' +
      '[<upstream>] <cairn-NNNN> <confirmed|refuted|inconclusive> "note"',
  );
  console.error('  omit <upstream> to record against a finding in this corpus');
  process.exit(2);
}
if (!['confirmed', 'refuted', 'inconclusive'].includes(verdict)) {
  console.error('verdict must be confirmed, refuted or inconclusive');
  process.exit(2);
}
const key = loadKeys().get(keyId);
if (!key || key.label !== agent) {
  console.error(`key ${keyId} is not published, or its label is not "${agent}"`);
  process.exit(2);
}
const privFile = path.join(process.cwd(), '.cairn-secrets', `${keyId}.key`);
if (!fs.existsSync(privFile)) {
  console.error('private key not found');
  process.exit(2);
}

const observation = {
  at: new Date().toISOString(),
  by: agent,
  verdict: verdict as 'confirmed' | 'refuted' | 'inconclusive',
  note: noteParts.join(' ') || undefined,
  environment: {
    os: process.platform,
    arch: process.arch,
    runtime: `node ${process.version}`,
    note: `${os.type()} ${os.release()}`,
  },
};

// The observation attests to the body as it stood when the check ran. Without
// this it would survive that body being amended, which is the hole this whole
// mechanism exists to close.
if (isLocal) {
  const full = resolveFindingFile(findingId);
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const finding = FindingSchema.parse(raw);
  const value = signObservation(
    findingId,
    observation,
    fs.readFileSync(privFile, 'utf8'),
    findingBodyHash(finding),
  );
  raw.observations = [
    ...raw.observations,
    { ...observation, signature: { algorithm: 'ed25519', keyId, value } },
  ];
  writeJsonAtomic(full, raw);

  console.log(`recorded ${verdict} on ${findingId} as ${agent}`);
  console.log(`  ${path.relative(process.cwd(), full)}`);
  console.log('\nCommit it. If you have a sealed forecast on this finding:');
  console.log(`  CAIRN_AGENT=${agent} npm run cairn:reveal -- ${findingId}`);
} else {
  const target = loadFederated().find((x) => x.upstream === upstream && x.finding.id === findingId);
  if (!target) {
    console.error(`no cached finding ${findingId} from upstream "${upstream}" — run cairn:federate first`);
    process.exit(2);
  }
  const value = signObservation(
    findingId,
    observation,
    fs.readFileSync(privFile, 'utf8'),
    findingBodyHash(target.finding),
  );
  const signed = { ...observation, signature: { algorithm: 'ed25519', keyId, value } };

  const dir = path.join(OVERLAY_DIR, upstream as string);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${findingId}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  existing.push(signed);
  writeJsonAtomic(file, existing);

  console.log(`recorded ${verdict} on ${upstream}:${findingId} as ${agent}`);
  console.log(`  ${path.relative(process.cwd(), file)}`);
  console.log('\nThis changes your local confidence now. Send the file upstream');
  console.log('as a pull request to change theirs.');
}
