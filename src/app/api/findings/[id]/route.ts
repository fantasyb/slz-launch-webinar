import { NextResponse } from 'next/server';
import { getFinding, serialize } from '@/lib/cairn/load';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const finding = getFinding((await params).id);
  if (!finding) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(serialize(finding));
}
