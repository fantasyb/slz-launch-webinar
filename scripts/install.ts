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
    console.error('--from requires --key <keyId>.');
    console.error('Fetching a block without pinning a key is the failure recorded as cairn-0014:');
    console.error('it authorises whoever controls that URL, indefinitely.');
    process.exit(2);
  }

  const known = loadKeys().get(pinnedKey);
  if (!known) {
    console.error(`key ${pinnedKey} is not in keys/. Obtain the public key out of band`);
    console.error('and add it before trusting a fetched block — never take it from the same host.');
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
    signature?: { keyId: string; value: string } | null;
  };

  if (!payload.base || !payload.block) {
    console.error('response is missing base or block');
    process.exit(1);
  }
  if (!payload.signature) {
    console.error('block is unsigned. You pinned a key, so this is refused.');
    process.exit(1);
  }
  if (payload.signature.keyId !== pinnedKey) {
    console.error(`block is signed by ${payload.signature.keyId}, not ${pinnedKey}. Refusing.`);
    process.exit(1);
  }
  if (!verifyBlockSignature(payload.base, payload.block, payload.signature.value, known.publicKey)) {
    console.error('SIGNATURE DOES NOT VERIFY. The block was altered in transit or the host');
    console.error('is not who you think. Nothing written.');
    process.exit(1);
  }

  return {
    base: payload.base,
    block: payload.block,
    provenance: `fetched from ${from}, signature verified against ${pinnedKey} (${known.label})`,
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
