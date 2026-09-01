/**
 * cairn:warm — fetch a prebuilt index instead of computing one.
 *
 *   npm run cairn:warm -- --from https://HOST --key <keyId>
 *   npm run cairn:warm -- --from https://HOST --unsigned-ok   (development only)
 *
 * Building the index is seventeen seconds at ten thousand findings, and every
 * consumer of a given corpus computes the byte-identical result from
 * byte-identical input. Downloading it is 4.3MB and 122ms.
 *
 * TWO INDEPENDENT GATES, AND BOTH MUST PASS
 *
 * SIGNATURE. This is derived data from a host, which is the shape of
 * cairn-0014. A poisoned index cannot invent findings -- the prose still comes
 * from the local corpus -- but it can omit a finding's postings so it is never
 * retrieved, or inflate a confidence so a stale claim reads as fresh. Both are
 * silent. So the signature is checked against a key pinned out of band, the
 * same trust model the install block uses.
 *
 * FINGERPRINT. The index must be for THIS corpus. Checked independently of the
 * signature, because a correctly signed index for a different corpus is still
 * the wrong index, and a host that has moved on is a likelier failure than a
 * hostile one.
 *
 * Failing either gate is not an error. It means building locally, which is
 * what would have happened anyway; the download is an optimisation and must
 * never be load-bearing.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { gunzipSync } from 'zlib';
import { loadCorpus } from '../src/lib/cairn/load';
import { corpusFingerprint, indexIdentity } from '../src/lib/cairn/retrieval';
import { deserialize } from '../src/lib/cairn/columnar';
import { loadKeys } from '../src/lib/cairn/keys';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const from = arg('from');
const pinnedKeyId = arg('key');
const unsignedOk = argv.includes('--unsigned-ok');

if (!from) {
  console.error('usage: npm run cairn:warm -- --from https://HOST [--key <keyId>]');
  process.exit(2);
}

function bail(reason: string): never {
  console.log(`\nNot using the served index: ${reason}`);
  console.log('The index will be built locally on the next query, which is slower and correct.\n');
  process.exit(0);
}

async function main() {
  const local = loadCorpus();
  const want = indexIdentity(local);
  const wantCorpus = corpusFingerprint(local);

  console.log(`\nfetching ${from}/api/index.bin`);
  const res = await fetch(`${from}/api/index.bin`);
  if (!res.ok) bail(`host returned ${res.status}`);

  const body = Buffer.from(await res.arrayBuffer());
  const sig = res.headers.get('x-cairn-signature');
  const keyId = res.headers.get('x-cairn-key-id');
  const claimed = res.headers.get('x-cairn-fingerprint');
  console.log(`  ${(body.length / 1024).toFixed(0)} KB, ${res.headers.get('x-cairn-findings')} findings`);

  // --- gate 1: signature ---
  if (!sig || !keyId) {
    if (!unsignedOk) bail('the host did not sign it, and --unsigned-ok was not given');
    console.log('  signature: ABSENT (accepted only because --unsigned-ok was given)');
  } else {
    const record = loadKeys().get(keyId);
    if (!record) bail(`signed by key ${keyId}, which is not published in keys/`);
    if (pinnedKeyId && pinnedKeyId !== keyId) {
      bail(`signed by ${keyId} but ${pinnedKeyId} was pinned`);
    }
    if (!pinnedKeyId && !unsignedOk) {
      bail('no --key pinned. A signature nobody chose to trust proves only that somebody signed something');
    }
    const ok = crypto.verify(
      null,
      body,
      crypto.createPublicKey(record.publicKey),
      Buffer.from(sig, 'base64'),
    );
    if (!ok) bail('the signature does not verify against the pinned key');
    console.log(`  signature: verified against ${keyId} (${record.label})`);
  }

  // --- gate 2: is this index for THIS corpus ---
  const raw = gunzipSync(body);
  const parsed = deserialize(raw, want);
  if (!parsed) {
    // Three distinguishable outcomes, because the fix differs for each: pull
    // the corpus, upgrade cairn, or retry the download.
    bail(
      claimed !== wantCorpus
        ? `it is for a different corpus (host ${claimed?.slice(0, 12)}, local ${wantCorpus.slice(0, 12)})`
        : res.headers.get('x-cairn-index-identity') !== want
          ? 'it is for this corpus but was built by a different version of cairn'
          : 'the index did not parse — truncated download or a newer format',
    );
  }
  console.log(`  fingerprint: matches this corpus (${wantCorpus.slice(0, 12)})`);
  console.log(`  indexer:     matches this version (${want.slice(0, 12)})`);

  const dir = path.join(process.cwd(), '.cairn-cache');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index-v3.bin');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);

  console.log(`\nInstalled. The next query loads it instead of building.\n`);
}

void main();
