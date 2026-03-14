import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await db.agent.findUnique({ where: { id } });

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  return NextResponse.json(agent);
}
