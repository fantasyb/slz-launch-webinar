import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { getFinding, serialize } from '@/lib/cairn/load';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const finding = getFinding((await params).id);
  // A private (non-shared) finding is 404 over HTTP, same as if it did not
  // exist — the API must not publish what visibility withheld.
  if (!finding || finding.visibility !== 'shared') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    ...serialize(finding),
  });
}
