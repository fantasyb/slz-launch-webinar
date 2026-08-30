import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { installBlock, signBlock, validateBlockShape } from '@/lib/cairn/block';
import { loadKeys } from '@/lib/cairn/keys';

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
  const keyFile = signer
    ? path.join(process.cwd(), '.cairn-secrets', `${signer.keyId}.key`)
    : null;

  if (!signer || !keyFile || !fs.existsSync(keyFile)) {
    // Unsigned is still served, and says so, so a verifying client fails closed
    // rather than silently accepting an unauthenticated block.
    return NextResponse.json({
      version: 'cairn-block-v1',
      base,
      block,
      signature: null,
      warning:
        'This host has no signing key available, so the block is unauthenticated. ' +
        'A client that pinned a key must refuse it. Paste the block by hand instead.',
    });
  }

  return NextResponse.json({
    version: 'cairn-block-v1',
    base,
    block,
    signature: {
      algorithm: 'ed25519',
      keyId: signer.keyId,
      value: signBlock(base, block, fs.readFileSync(keyFile, 'utf8')),
    },
    verify:
      'Recompute over JSON.stringify(["cairn-block-v1", base, block]) with the ed25519 ' +
      'public key for keyId, which you should already hold — do not fetch it from here.',
  });
}
