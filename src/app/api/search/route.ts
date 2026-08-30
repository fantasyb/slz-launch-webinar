import { NextResponse } from 'next/server';
import { UNTRUSTED_NOTICE, UNTRUSTED_FIELDS } from '@/lib/cairn/safety';
import { search, serialize } from '@/lib/cairn/load';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') ?? '';
  if (!q.trim()) {
    return NextResponse.json({ error: 'missing required parameter: q' }, { status: 400 });
  }
  const results = search(q);
  return NextResponse.json({
    _notice: UNTRUSTED_NOTICE,
    _untrustedFields: UNTRUSTED_FIELDS,
    query: q,
    count: results.length,
    generatedAt: new Date().toISOString(),
    findings: results.map((f) => serialize(f)),
  });
}
