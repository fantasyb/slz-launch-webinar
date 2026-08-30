import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { installBlock, signBlock, validateBlockShape } from '@/lib/cairn/block';
import { loadKeys } from '@/lib/cairn/keys';
import { keyFingerprint } from '@/lib/cairn/signing';

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
  const host = request.headers.get('host') ?? 'CAIRN_HOST';
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  const base = `${proto}://${host}`;
  const block = installBlock(base);

  // Never serve a block this host would itself reject.
  const problems = validateBlockShape(base, block);
  if (problems.length) {
    return NextResponse.json(
      { error: 'refusing to serve a block that fails its own shape check', problems },
      { status: 500 },
    );
  }

  const signer = [...loadKeys().values()].find((k) => !k.origin);

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
        'This host has no signing key available, so the block is unauthenticated. ' +
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
