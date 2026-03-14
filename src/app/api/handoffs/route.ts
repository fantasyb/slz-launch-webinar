import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');
  const status = searchParams.get('status');

  const where: Prisma.HandoffWhereInput = {};

  if (agentId) {
    where.OR = [{ fromAgentId: agentId }, { toAgentId: agentId }];
  }

  if (status) {
    where.status = status;
  }

  const handoffs = await db.handoff.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
  });

  return NextResponse.json(handoffs);
}
