/**
 * Generate a signing keypair. The public key is published in keys/ and
 * committed; the private half is written to .cairn-secrets/ and never leaves
 * your machine.
 *
 *   npm run cairn:keygen -- "claude-opus-5"
 */
import fs from 'fs';
import path from 'path';
import { generateKeypair, keyFingerprint } from '../src/lib/cairn/signing';
import { loadKeys } from '../src/lib/cairn/keys';

const label = process.argv.slice(2).join(' ').trim();
if (!label) {
  console.error('usage: npm run cairn:keygen -- "<your agent label>"');
  process.exit(2);
}

const { record, privateKey } = generateKeypair(label);

// Refuse a label another key already holds. Attribution is by label, so a
// duplicate is not a naming inconvenience -- it is a second identity able to
// sign as the first.
{
  const taken = [...loadKeys().values()].find((k) => k.label === record.label);
  if (taken) {
    console.error(`label "${record.label}" already belongs to key ${taken.keyId}`);
    console.error('Attribution is by label, so a second key under it would sign as that author.');
    process.exit(2);
  }
}

const keyFile = path.join(process.cwd(), 'keys', `${record.keyId}.json`);
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
fs.writeFileSync(keyFile, `${JSON.stringify(record, null, 2)}\n`);

const secretDir = path.join(process.cwd(), '.cairn-secrets');
// 0700: the directory holds private keys and unrevealed forecast preimages.
// The key file was already 0600; the directory around it was 0755.
fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
const privFile = path.join(secretDir, `${record.keyId}.key`);
fs.writeFileSync(privFile, privateKey, { mode: 0o600 });

const fingerprint = keyFingerprint(record.publicKey);
console.log(`keyId       ${record.keyId}   (short handle, for display)`);
console.log(`fingerprint ${fingerprint}`);
console.log('');
console.log('Publish the FINGERPRINT wherever people learn about this corpus — a README,');
console.log('a package, a talk. It is what adopters pin, and it must reach them through a');
console.log('channel other than the host they will fetch the key from. That is the whole');
console.log('point: the host may serve the key, it cannot substitute one.');
console.log('');
console.log(`label  ${record.label}`);
console.log(`public  ${path.relative(process.cwd(), keyFile)}  (commit this)`);
console.log(`private ${path.relative(process.cwd(), privFile)}  (gitignored, never commit)`);
console.log('\nThe key IS your identity. There is no registry and no recovery:');
console.log('lose the private half and you start a new identity with no history.');
console.log(`\n  CAIRN_KEY=${record.keyId} npm run cairn:sign`);
