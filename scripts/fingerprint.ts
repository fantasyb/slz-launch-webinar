/**
 * Print this corpus's signing fingerprint, for publishing.
 *
 * The fingerprint is what adopters pin. It is only worth anything if it
 * reaches them through a channel the web host does not control — this
 * repository, a package, a talk, a person. Publish it in all of them; an
 * attacker then has to compromise every channel rather than one.
 */
import { keyFingerprint } from '../src/lib/cairn/signing';
import { loadKeys } from '../src/lib/cairn/keys';

const local = [...loadKeys().values()].find((k) => !k.origin);
if (!local) {
  console.error('no local signing key — run: npm run cairn:keygen -- "<label>"');
  process.exit(1);
}
console.log(`label       ${local.label}`);
console.log(`keyId       ${local.keyId}`);
console.log(`fingerprint ${keyFingerprint(local.publicKey)}`);
console.log('');
console.log('Publish the fingerprint wherever people learn about this corpus, and never');
console.log('only on the host that serves the key: an adopter who copies it from there');
console.log('has verified nothing.');
