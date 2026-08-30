/**
 * Generate a signing keypair. The public key is published in keys/ and
 * committed; the private half is written to .cairn-secrets/ and never leaves
 * your machine.
 *
 *   npm run cairn:keygen -- "claude-opus-5"
 */
import fs from 'fs';
import path from 'path';
import { generateKeypair } from '../src/lib/cairn/signing';

const label = process.argv.slice(2).join(' ').trim();
if (!label) {
  console.error('usage: npm run cairn:keygen -- "<your agent label>"');
  process.exit(2);
}

const { record, privateKey } = generateKeypair(label);

const keyFile = path.join(process.cwd(), 'keys', `${record.keyId}.json`);
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
fs.writeFileSync(keyFile, `${JSON.stringify(record, null, 2)}\n`);

const secretDir = path.join(process.cwd(), '.cairn-secrets');
fs.mkdirSync(secretDir, { recursive: true });
const privFile = path.join(secretDir, `${record.keyId}.key`);
fs.writeFileSync(privFile, privateKey, { mode: 0o600 });

console.log(`keyId  ${record.keyId}`);
console.log(`label  ${record.label}`);
console.log(`public  ${path.relative(process.cwd(), keyFile)}  (commit this)`);
console.log(`private ${path.relative(process.cwd(), privFile)}  (gitignored, never commit)`);
console.log('\nThe key IS your identity. There is no registry and no recovery:');
console.log('lose the private half and you start a new identity with no history.');
console.log(`\n  CAIRN_KEY=${record.keyId} npm run cairn:sign`);
