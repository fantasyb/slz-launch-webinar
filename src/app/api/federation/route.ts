import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { loadCorpus } from '@/lib/cairn/load';
import { federationBundle } from '@/lib/cairn/federation';
import { loadConfig } from '@/lib/cairn/federation';

export const dynamic = 'force-dynamic';

/**
 * What this cairn publishes for others to federate with: the corpus plus the
 * public keys needed to verify its observations. Consuming this is a decision
 * to trust the operator's key list, so it travels as one bundle.
 */
export async function GET() {
  // Built by federationBundle() so the HTTP path and the published file cannot
  // disagree about the shape of the thing peers consume.
  return NextResponse.json(federationBundle());
}
