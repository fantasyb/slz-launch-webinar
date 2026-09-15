/**
 * cairn:publish — write the bundle that makes this corpus federatable.
 *
 *   npm run cairn:publish
 *
 * Federation reads a peer's published bundle: its findings plus the public keys
 * needed to verify its observations. /api/federation serves that dynamically,
 * which means a corpus could only be federated FROM if somebody deployed it.
 *
 * That is a hosting requirement smuggled into a design whose whole point is
 * that it does not need one. A local upstream failed with ENOENT on
 * federation.json — the bundle existed only as an HTTP response.
 *
 * Written to a file, any git clone is a federation source. You keep your own
 * corpus, you point at somebody else's checkout or URL, their findings arrive
 * read-only and your observations overlay them. No server anywhere.
 *
 * Committed like the expansions are: it is derived, and it is also the thing
 * other people consume, so it should be visible in a diff when it changes.
 */
import fs from 'fs';
import { federationBundle } from '../src/lib/cairn/federation';
import { homePath } from '../src/lib/cairn/home';

const bundle = federationBundle();

const out = homePath('federation.json');
fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`\n  ${bundle.findings.length} findings, ${bundle.keys.length} key(s) -> ${out}`);
console.log('  Commit it. Anyone who clones this can now federate with it.\n');
