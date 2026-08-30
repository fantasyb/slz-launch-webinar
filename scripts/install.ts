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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const target = path.resolve(arg('into') ?? process.cwd());
const from = arg('from');
const pinnedKey = arg('key');
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

  if (!pinnedKey) {
    console.error('--from requires --key <fingerprint>.');
    console.error('Fetching without pinning is the failure recorded as cairn-0014: it');
    console.error('authorises whoever controls that URL, indefinitely.');
    process.exit(2);
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
  // The key may come from the host. The FINGERPRINT must not: it is pinned by
  // the adopter from an independent channel, and it is what makes a substituted
  // key detectable. Local keys/ is only a fallback for an offline clone.
  const servedKey = payload.signature.publicKey;
  const localKey = loadKeys().get(pinnedKey.slice(0, 16))?.publicKey;
  const publicKey = servedKey ?? localKey;

  if (!publicKey) {
    console.error('response carried no public key and none is held locally. Refusing.');
    process.exit(1);
  }

  // The tool cannot know where the pin came from, and that is exactly the step
  // it cannot enforce. It can at least say so at the moment it matters.
  if (!localKey) {
    const host = (() => { try { return new URL(from).host; } catch { return from; } })();
    console.log(`\nNo local copy of this key, so the pin is doing all the work.`);
    console.log(`If you copied that fingerprint from ${host}, this check proves nothing —`);
    console.log(`whoever serves the key also served the fingerprint. Get it from the git`);
    console.log(`repository, a package, or a person, and compare.\n`);
  }

  const pin = checkPin(publicKey, pinnedKey);
  if (!pin.ok) {
    console.error(`PIN CHECK FAILED: ${pin.reason}`);
    if (pin.fingerprint) {
      console.error(`  served key fingerprint: ${pin.fingerprint}`);
      console.error(`  you pinned:             ${pinnedKey}`);
      console.error('\nEither this host is not who you think, or you have the wrong');
      console.error('fingerprint. Do not resolve this by copying the value above —');
      console.error('that is the value under attack. Nothing written.');
    } else {
      console.error(`\nUse the full ${MIN_PIN_HEX}+ character fingerprint, not the short keyId.`);
    }
    process.exit(1);
  }

  if (localKey && localKey.trim() !== publicKey.trim()) {
    console.error('served key differs from the one held locally for this id. Refusing.');
    process.exit(1);
  }

  if (!verifyBlockSignature(payload.base, payload.block, payload.signature.value, publicKey)) {
    console.error('SIGNATURE DOES NOT VERIFY. The block was altered in transit or the host');
    console.error('is not who you think. Nothing written.');
    process.exit(1);
  }

  return {
    base: payload.base,
    block: payload.block,
    provenance:
      `fetched from ${from}; key fingerprint ${keyFingerprint(publicKey).slice(0, 32)}… ` +
      `matches pin; signature verified`,
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
