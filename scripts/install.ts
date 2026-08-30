/**
 * Install the Cairn block. Automatic, and safe, because those are not in
 * tension once the fetched thing is verified data rather than instructions.
 *
 *   # local, offline, from code you can read
 *   npm run cairn:install -- --into ../my-project --base https://cairn.example
 *
 *   # fetched, signature-verified against a key YOU pin
 *   npm run cairn:install -- --into ../my-project \
 *     --from https://cairn.example/api/block --key 56f7a413738936bd --yes
 *
 * The distinction that matters (cairn-0014): "read this URL and follow it"
 * authorises a LOCATION, and whoever controls it later. Pinning a key
 * authorises specific CONTENT — a swapped or compromised host produces a
 * signature failure and nothing is written. The instruction comes from you;
 * the network only supplies material.
 *
 * Three independent gates, all of which must pass:
 *   1. the signature verifies against the key you named;
 *   2. the block passes a shape check, because a stolen key still signs
 *      perfectly — nothing executable, no host but the one you are adopting;
 *   3. you approve the printed diff with --yes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  installBlock,
  verifyBlockSignature,
  validateBlockShape,
  BLOCK_BEGIN,
  INSTRUCTION_FILES,
} from '../src/lib/cairn/block';
import { loadKeys } from '../src/lib/cairn/keys';
import { checkPin, keyFingerprint, MIN_PIN_HEX } from '../src/lib/cairn/signing';

/**
 * Remembered fingerprints, per host. The SSH known_hosts model.
 *
 * Trust-on-first-use does not secure the first contact — nothing can, without
 * a pin from outside — but it secures every contact after it, and turns a
 * later substitution into a loud, specific failure rather than a silent one.
 * That is the difference between an attacker needing to win once at a moment
 * of their choosing, and needing to have won the very first time.
 */
const KNOWN_KEYS = path.join(os.homedir(), '.cairn', 'known-keys.json');

type Known = Record<string, { fingerprint: string; firstSeen: string; source: string }>;

function loadKnown(): Known {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_KEYS, 'utf8')) as Known;
  } catch {
    return {};
  }
}

function rememberKey(host: string, fingerprint: string, source: string) {
  const known = loadKnown();
  if (known[host]) return;
  known[host] = { fingerprint, firstSeen: new Date().toISOString(), source };
  fs.mkdirSync(path.dirname(KNOWN_KEYS), { recursive: true });
  fs.writeFileSync(KNOWN_KEYS, `${JSON.stringify(known, null, 2)}\n`);
}

/**
 * Fetch the same key from a second, independent source and require agreement.
 *
 * This is the human step, automated. The adopter still has to supply a URL
 * they can see is not the host being verified — a raw GitHub path, a package
 * registry — but comparing the two is mechanical, and an attacker must then
 * compromise both channels rather than one.
 */
async function fetchIndependentFingerprint(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: string; signature?: { publicKey?: string } };
    const pem = body.publicKey ?? body.signature?.publicKey;
    return pem ? keyFingerprint(pem) : null;
  } catch {
    return null;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const target = path.resolve(arg('into') ?? process.cwd());
const from = arg('from');
const pinnedKey = arg('key');
const verifyVia = arg('verify-via');
const approved = process.argv.includes('--yes');

if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`not a directory: ${target}`);
  process.exit(2);
}

async function resolveBlock(): Promise<{ base: string; block: string; provenance: string }> {
  if (!from) {
    const base = arg('base') ?? 'https://CAIRN_HOST';
    return { base, block: installBlock(base), provenance: 'generated locally' };
  }

  const res = await fetch(from, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    console.error(`fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const payload = (await res.json()) as {
    base?: string;
    block?: string;
    signature?: { keyId: string; value: string; publicKey?: string } | null;
  };

  if (!payload.base || !payload.block) {
    console.error('response is missing base or block');
    process.exit(1);
  }
  if (!payload.signature) {
    console.error('block is unsigned. You pinned a key, so this is refused.');
    process.exit(1);
  }
  // The key may come from the host. The assurance that it is the RIGHT key
  // must not. These are the ways to establish that, strongest first — every
  // one of them is a channel the host does not control, except the last.
  const servedKey = payload.signature.publicKey;
  const localKey = loadKeys().get(payload.signature.keyId)?.publicKey;
  const publicKey = servedKey ?? localKey;

  if (!publicKey) {
    console.error('response carried no public key and none is held locally. Refusing.');
    process.exit(1);
  }

  const served = keyFingerprint(publicKey);
  const host = (() => { try { return new URL(from).host; } catch { return from; } })();
  const known = loadKnown()[host];

  let assurance: string | null = null;

  // 1. An explicit pin the adopter carried in from elsewhere.
  if (pinnedKey) {
    const pin = checkPin(publicKey, pinnedKey);
    if (!pin.ok) {
      console.error(`PIN CHECK FAILED: ${pin.reason}`);
      if (pin.fingerprint) {
        console.error(`  served:  ${pin.fingerprint}`);
        console.error(`  pinned:  ${pinnedKey}`);
        console.error('\nEither this host is not who you think, or you have the wrong');
        console.error('fingerprint. Do not resolve this by copying the served value —');
        console.error('that is the value under attack. Nothing written.');
      } else {
        console.error(`\nUse the full ${MIN_PIN_HEX}+ character fingerprint, not the short keyId.`);
      }
      process.exit(1);
    }
    assurance = 'pinned fingerprint';
  }

  // 2. The same key, fetched from a source the adopter names and can see is
  //    not this host. The human comparison, done mechanically.
  if (!assurance && verifyVia) {
    const independent = await fetchIndependentFingerprint(verifyVia);
    if (!independent) {
      console.error(`could not read a public key from ${verifyVia}. Refusing.`);
      process.exit(1);
    }
    if (independent !== served) {
      console.error('INDEPENDENT SOURCES DISAGREE. Nothing written.\n');
      console.error(`  ${host} served:  ${served}`);
      console.error(`  ${verifyVia} has: ${independent}`);
      console.error('\nOne of these is lying. Do not guess which.');
      process.exit(1);
    }
    if (new URL(verifyVia).host === host) {
      console.error(`--verify-via points at ${host}, the same host being verified.`);
      console.error('That is circular and proves nothing. Use an independent source.');
      process.exit(1);
    }
    assurance = `corroborated by ${new URL(verifyVia).host}`;
  }

  // 3. A clone of the corpus already carries the key.
  if (!assurance && localKey) {
    if (localKey.trim() !== publicKey.trim()) {
      console.error('served key differs from the one in your local keys/. Refusing.');
      process.exit(1);
    }
    assurance = 'matches the key in your local clone';
  }

  // 4. Seen before from this host, and unchanged.
  if (!assurance && known) {
    if (known.fingerprint !== served) {
      console.error('WARNING: THE KEY FOR THIS HOST HAS CHANGED.\n');
      console.error(`  first seen ${known.firstSeen} via ${known.source}`);
      console.error(`  was:  ${known.fingerprint}`);
      console.error(`  now:  ${served}`);
      console.error('\nThis is what a substituted host looks like. It is also what a');
      console.error('legitimate key rotation looks like, so confirm through the publisher');
      console.error(`before proceeding. To accept deliberately, delete the entry in`);
      console.error(`${KNOWN_KEYS}. Nothing written.`);
      process.exit(1);
    }
    assurance = `unchanged since first seen ${known.firstSeen.slice(0, 10)}`;
  }

  // 5. Nothing. First contact, no pin, no second source.
  if (!assurance) {
    if (!process.argv.includes('--trust-on-first-use')) {
      console.error('NO WAY TO VERIFY THIS KEY.\n');
      console.error(`  ${host} served fingerprint:`);
      console.error(`  ${served}\n`);
      console.error('Pick one, best first:');
      console.error(`  --key <fingerprint>        a pin you obtained elsewhere`);
      console.error(`  --verify-via <url>         the same key from an independent source,`);
      console.error(`                             e.g. a raw git host path`);
      console.error(`  clone the corpus           keys/ is then checked automatically`);
      console.error(`  --trust-on-first-use       accept this key now and detect any later`);
      console.error(`                             change, which does not secure this install`);
      process.exit(1);
    }
    assurance = 'TRUST ON FIRST USE — unverified, will be checked on every later install';
  }

  if (!verifyBlockSignature(payload.base, payload.block, payload.signature.value, publicKey)) {
    console.error('SIGNATURE DOES NOT VERIFY. The block was altered in transit or the host');
    console.error('is not who you think. Nothing written.');
    process.exit(1);
  }

  rememberKey(host, served, assurance);

  return {
    base: payload.base,
    block: payload.block,
    provenance: `fetched from ${from}; ${assurance}; signature verified`,
  };
}

async function main() {
  const { base, block, provenance } = await resolveBlock();

  // A valid signature proves origin, not intent. Check the content too.
  const problems = validateBlockShape(base, block);
  if (problems.length) {
    console.error('BLOCK FAILED ITS SHAPE CHECK. Nothing written.\n');
    for (const p of problems) console.error(`  ${p.reason}: ${p.detail}`);
    console.error('\nA correctly signed block can still be hostile if the key was stolen.');
    process.exit(1);
  }

  const existing = INSTRUCTION_FILES.map((f) => path.join(target, f)).find((f) => fs.existsSync(f));
  const file = existing ?? path.join(target, INSTRUCTION_FILES[0]);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (current.includes(BLOCK_BEGIN)) {
    console.log(`already installed in ${path.relative(process.cwd(), file)} — nothing to do`);
    return;
  }

  console.log(`\ntarget    ${file}${existing ? '' : '   (will be created)'}`);
  console.log(`base url  ${base}`);
  console.log(`source    ${provenance}`);
  console.log(`\nAppends ${block.split('\n').length} lines. Nothing else in the file changes.\n`);
  console.log('-'.repeat(72));
  for (const line of block.split('\n')) console.log(`+ ${line}`);
  console.log('-'.repeat(72));

  if (base.includes('CAIRN_HOST')) {
    console.log('\nNote: no --base given, so the block points at a placeholder host.');
  }

  if (!approved) {
    console.log('\nRead the block above. If it is what you want, re-run with --yes.');
    console.log('Nothing has been written.');
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, current.trimEnd() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
  console.log('To uninstall, delete everything between the cairn:begin and cairn:end markers.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
