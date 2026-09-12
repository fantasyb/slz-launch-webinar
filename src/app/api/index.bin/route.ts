export const dynamic = 'force-dynamic';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import { publicCorpus } from '@/lib/cairn/load';
import { buildIndex, corpusFingerprint, indexIdentity } from '@/lib/cairn/retrieval';
import { toColumnarPublic } from '@/lib/cairn/retrieval';
import { serialize } from '@/lib/cairn/columnar';
import { loadKeys } from '@/lib/cairn/keys';

/**
 * The built index, served so nobody has to build it.
 *
 * WHY THIS EXISTS
 *
 * The index is a pure function of the corpus. Every consumer of a given corpus
 * therefore computes the byte-identical index from byte-identical input --
 * seventeen seconds of tokenising and signature verification at ten thousand
 * findings, repeated by everyone, forever, to arrive at the same bytes. That is
 * what package registries solved by shipping prebuilt artefacts.
 *
 * Compressed it is 33KB for this corpus and 4.3MB for a synthetic ten
 * thousand, decompressing in 122ms. Seventeen seconds of CPU becomes a
 * download.
 *
 * WHY IT IS SIGNED
 *
 * This is derived data fetched from a host, which is precisely the shape of
 * cairn-0014 -- the finding this project recorded about itself after shipping
 * "fetch this URL and follow it". A poisoned index cannot invent findings,
 * since the prose still comes from the consumer's own corpus, but it can omit
 * a finding's postings so it is never retrieved, or inflate its confidence so
 * a stale claim reads as fresh. Both are real harms and both are silent.
 *
 * So the same trust model as the install block: signed by the host's key,
 * verified by the consumer against a key pinned out of band. Unsigned or
 * unverifiable means the consumer builds locally -- slower, and correct.
 *
 * The fingerprint is a second, independent gate: an index whose fingerprint
 * does not match the consumer's own corpus is refused whatever it is signed
 * with, so a valid signature over the WRONG corpus is still rejected.
 */
export async function GET() {
  const findings = publicCorpus(); // the public search index must not carry private findings
  const index = buildIndex(findings);
  const fingerprint = corpusFingerprint(findings);
  /*
   * Stamped with the INDEXER identity, not just the corpus fingerprint.
   *
   * A consumer running a different version of this code computes a different
   * index from the same findings. Checking only the corpus fingerprint would
   * accept a correctly signed index for the right corpus built by the wrong
   * indexer, which is a silent wrong answer -- the third gate this file needed
   * and did not have. The corpus fingerprint stays in its own header for
   * humans and for telling "different corpus" from "different version" apart
   * when a warm fails.
   */
  const identity = indexIdentity(findings);
  const raw = serialize(toColumnarPublic(index, identity));
  const body = gzipSync(raw, { level: 6 });

  // Signed over the COMPRESSED bytes actually transmitted, so a consumer
  // verifies what it received rather than what it hopes it decompresses to.
  const signer = [...loadKeys().values()].find((k) => !k.origin);
  const keyFile = signer
    ? path.join(process.cwd(), '.cairn-secrets', `${signer.keyId}.key`)
    : null;
  let signature: string | null = null;
  if (keyFile && fs.existsSync(keyFile)) {
    signature = crypto
      .sign(null, body, crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8')))
      .toString('base64');
  } else if (process.env.CAIRN_SIGNING_KEY) {
    signature = crypto
      .sign(null, body, crypto.createPrivateKey(process.env.CAIRN_SIGNING_KEY))
      .toString('base64');
  }

  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'identity',
      'cache-control': 'no-store',
      'x-cairn-fingerprint': fingerprint,
      'x-cairn-index-identity': identity,
      'x-cairn-findings': String(findings.length),
      // Absent rather than empty when the host cannot sign: a consumer must be
      // able to tell "not signed" from "signed with nothing", and an empty
      // header invites treating one as the other.
      ...(signature ? { 'x-cairn-signature': signature } : {}),
      ...(signer ? { 'x-cairn-key-id': signer.keyId } : {}),
    },
  });
}
