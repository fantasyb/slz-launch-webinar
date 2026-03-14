import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const agents = await db.agent.findMany({
    orderBy: { reputationScore: 'desc' },
  });
  return NextResponse.json(agents);
}
