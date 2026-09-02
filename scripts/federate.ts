/**
 * Pull upstream cairns into .cairn-cache/.
 *
 *   npm run cairn:federate
 *
 * A source is either an https URL pointing at another cairn's /api/federation,
 * or a local path holding the same bundle — which is how the demo upstream
 * works without network access.
 *
 * Every upstream observation is verified against that upstream's own published
 * keys at pull time. Unverifiable ones are reported, not silently accepted.
 */
import fs from 'fs';
import path from 'path';
import {
  loadConfig,
  FederationBundleSchema,
  cacheDir,
  type Upstream,
} from '../src/lib/cairn/federation';
import {
  verifyObservation,
  findingBodyHash,
  deriveKeyId,
  validateLabel,
  type KeyRecord,
} from '../src/lib/cairn/signing';
import { loadKeys } from '../src/lib/cairn/keys';
import { fetchJson } from '../src/lib/cairn/fetchJson';
import { cairnHome } from '../src/lib/cairn/home';

async function fetchBundle(up: Upstream): Promise<unknown> {
  if (up.source.startsWith('http://') || up.source.startsWith('https://')) {
    return fetchJson(up.source);
  }
  /*
   * Relative to the CORPUS, not to wherever this was invoked from. sync now
   * runs federate from the install directory, so a personal config saying
   * "../cairn" resolved against the install root and fetched the wrong thing
   * -- or nothing.
   */
  const dir = path.resolve(cairnHome(), up.source);
  const file = fs.statSync(dir).isDirectory() ? path.join(dir, 'federation.json') : dir;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const config = loadConfig();
  if (config.upstreams.length === 0) {
    console.log('no upstreams configured in cairn.config.json');
    process.exit(0);
  }

  fs.mkdirSync(cacheDir(), { recursive: true });
  let failures = 0;

  for (const up of config.upstreams) {
    try {
      const raw = await fetchBundle(up);
      const parsed = FederationBundleSchema.safeParse(raw);
      if (!parsed.success) {
        console.error(`FAIL  ${up.name} — bundle does not validate: ${parsed.error.issues[0].message}`);
        failures++;
        continue;
      }
      const bundle = parsed.data;

      // Same gate loadFederated applies, for the same reason: a key record
      // must derive its id from its own material, and its label must render
      // unambiguously. Building the map straight from the bundle meant the
      // signed/unverified counts printed below — the numbers an operator
      // reads to decide whether an upstream is trustworthy — were computed
      // with key records nobody had checked. The consumer was hardened and
      // its sibling here was left behind, which is what cairn-0021 is about.
      const keys = new Map<string, KeyRecord>();
      let rejectedKeys = 0;
      for (const k of bundle.keys as KeyRecord[]) {
        if (deriveKeyId(k.publicKey) !== k.keyId || validateLabel(k.label)) {
          rejectedKeys++;
          continue;
        }
        keys.set(k.keyId, k);
      }

      let verified = 0;
      let unverified = 0;
      for (const f of bundle.findings) {
        for (const o of f.observations) {
          if (verifyObservation(f.id, o, keys, findingBodyHash(f)) === 'signed') verified++;
          else unverified++;
        }
      }

      fs.writeFileSync(
        path.join(cacheDir(), `${up.name}.json`),
        `${JSON.stringify(bundle, null, 2)}\n`,
      );
      console.log(
        `ok    ${up.name} <- ${bundle.origin}: ${bundle.findings.length} findings, ` +
          `${bundle.keys.length} keys, ${verified} signed / ${unverified} unverified observations`,
      );
      if (rejectedKeys > 0) {
        console.log(
          `      ${rejectedKeys} key record(s) rejected: id does not derive from the key ` +
            `material, or the label is not unambiguously renderable.`,
        );
      }
      if (unverified > 0) {
        console.log(
          `      ${unverified} upstream observation(s) are unsigned or do not verify. ` +
            `They count half toward breadth, as local unsigned ones do.`,
        );
      }
    } catch (e) {
      console.error(`FAIL  ${up.name} — ${(e as Error).message}`);
      failures++;
    }
  }

  console.log(`\n${config.upstreams.length - failures}/${config.upstreams.length} upstream(s) pulled`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
