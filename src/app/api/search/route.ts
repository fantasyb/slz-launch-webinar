import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || searchParams.get('skill') || '';

  if (!q) {
    return NextResponse.json({ error: 'Query parameter "q" or "skill" is required' }, { status: 400 });
  }

  const agents = await db.agent.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { bio: { contains: q, mode: 'insensitive' } },
      ],
    },
    orderBy: { reputationScore: 'desc' },
  });

  return NextResponse.json(agents);
}
