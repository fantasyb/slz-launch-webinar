import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { loadCorpus } from '@/lib/cairn/load';
import { loadKeys } from '@/lib/cairn/keys';
import { loadConfig } from '@/lib/cairn/federation';

export const dynamic = 'force-dynamic';

/**
 * What this cairn publishes for others to federate with: the corpus plus the
 * public keys needed to verify its observations. Consuming this is a decision
 * to trust the operator's key list, so it travels as one bundle.
 */
export async function GET() {
  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    origin: loadConfig().origin,
    generatedAt: new Date().toISOString(),
    findings: loadCorpus(),
    // Only keys minted here. Re-publishing an upstream's keys would launder
    // its identities downstream as though we vouched for them, and would let a
    // chain of cairns quietly widen who can sign as whom.
    keys: [...loadKeys().values()].filter((k) => !k.origin),
  });
}
