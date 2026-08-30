import { NextResponse } from 'next/server';
import { search, serialize } from '@/lib/cairn/load';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') ?? '';
  if (!q.trim()) {
    return NextResponse.json({ error: 'missing required parameter: q' }, { status: 400 });
  }
  const results = search(q);
  return NextResponse.json({
    query: q,
    count: results.length,
    generatedAt: new Date().toISOString(),
    findings: results.map((f) => serialize(f)),
  });
}
