import { NextResponse } from 'next/server';
import { searchAgents } from '@/data/seed';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || searchParams.get('skill') || '';

  if (!q) {
    return NextResponse.json({ error: 'Query parameter "q" or "skill" is required' }, { status: 400 });
  }

  const results = searchAgents(q);
  return NextResponse.json(results);
}
