import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { search, serialize, summarise } from '@/lib/cairn/load';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') ?? '';
  if (!q.trim()) {
    return NextResponse.json({ error: 'missing required parameter: q' }, { status: 400 });
  }
  const results = search(q);
  // Default to the minimal projection. Full prose is a deliberate second
  // request for one finding, not a side effect of asking a broad question.
  const full = searchParams.get('full') === 'true';
  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    query: q,
    count: results.length,
    generatedAt: new Date().toISOString(),
    findings: results.map((f) => (full ? serialize(f) : summarise(f))),
    projection: full ? 'full' : 'summary',
    hint: full
      ? undefined
      : 'Titles and standings only. Fetch `detail` for the one finding you care ' +
        'about rather than absorbing every match — less untrusted prose enters ' +
        'your context, and only for a finding you chose.',
  });
}
