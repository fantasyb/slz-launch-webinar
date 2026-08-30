import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { installBlock, signBlock, validateBlockShape } from '@/lib/cairn/block';
import { loadKeys } from '@/lib/cairn/keys';
import { keyFingerprint } from '@/lib/cairn/signing';
import { resolveOrigin } from '@/lib/cairn/origin';

export const dynamic = 'force-dynamic';

/**
 * The install block, signed, as data.
 *
 * This is what makes one-command adoption safe rather than a standing RCE
 * primitive: the caller pins a key and verifies, so a compromised or replaced
 * host produces a signature failure instead of silent code execution. Compare
 * /install.md, which declines to be followed, and cairn-0014 for why.
 */
export async function GET(request: Request) {
  // Never from the Host header. See src/lib/cairn/origin.ts: deriving `base`
  // from the request turned this route into an oracle that would sign an
  // install block pointing anywhere the caller named, using the real key.
  const { base, canonical, reason } = resolveOrigin(request);
  const block = installBlock(base);

  // Never serve a block this host would itself reject.
  const problems = validateBlockShape(base, block);
  if (problems.length) {
    return NextResponse.json(
      { error: 'refusing to serve a block that fails its own shape check', problems },
      { status: 500 },
    );
  }

  const signer = canonical ? [...loadKeys().values()].find((k) => !k.origin) : null;

  // On a real deployment .cairn-secrets/ does not exist — it is gitignored, as
  // a private key must be. So the key comes from the environment first, and
  // the local file is only a development convenience. Without this the signed
  // install path is inoperative everywhere it actually matters.
  const keyFile = signer
    ? path.join(process.cwd(), '.cairn-secrets', `${signer.keyId}.key`)
    : null;
  const privateKey =
    process.env.CAIRN_SIGNING_KEY ??
    (keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : null);

  if (!signer || !privateKey) {
    // Unsigned is still served, and says so, so a verifying client fails closed
    // rather than silently accepting an unauthenticated block.
    return NextResponse.json({
      version: 'cairn-block-v1',
      base,
      block,
      signature: null,
      warning:
        reason === 'unconfigured'
          ? 'This deployment has no canonical origin configured, so it will not sign ' +
            'anything. The base below came from the request, which means a caller ' +
            'chooses it — exactly what a signature must not cover. Set CAIRN_BASE_URL ' +
            '(or an https origin in cairn.config.json) to enable verified installs.'
          : reason === 'host-mismatch'
            ? 'This request arrived under a different Host than this deployment\'s ' +
              'configured origin, so it is served unsigned and the base below is the ' +
              'configured one, not the one requested. Signing only the canonical ' +
              'origin is what stops a caller choosing the URLs inside a signed block.'
            : 'This host has no signing key available, so the block is unauthenticated. ' +
              'A client that pinned a key must refuse it, and cairn:install does. Set ' +
              'CAIRN_SIGNING_KEY to the PEM private key in the deployment environment ' +
              'to enable verified installs. Until then, paste the block by hand.',
    });
  }

  return NextResponse.json({
    version: 'cairn-block-v1',
    base,
    block,
    signature: {
      algorithm: 'ed25519',
      keyId: signer.keyId,
      value: signBlock(base, block, privateKey),
      // Served deliberately. A client cannot be harmed by receiving the public
      // key, because it pins a FINGERPRINT obtained elsewhere and checks that
      // this key hashes to it. Serving the key removes the need to have the
      // repository cloned; the pin removes the circularity of trusting it.
      publicKey: signer.publicKey,
      fingerprint: keyFingerprint(signer.publicKey),
    },
    verify:
      'Do not trust `fingerprint` from this response — it is here for display. Pin the ' +
      'fingerprint you obtained elsewhere, confirm sha256(publicKey) starts with it, then ' +
      'verify the signature over JSON.stringify(["cairn-block-v1", base, block]).',
  });
}
