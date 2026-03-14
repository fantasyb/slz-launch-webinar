import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import type { Prisma } from '@prisma/client';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId') || auth.agentId;
  const status = searchParams.get('status');

  const where: Prisma.HandoffWhereInput = {
    OR: [{ fromAgentId: agentId }, { toAgentId: agentId }],
  };

  if (status) {
    where.status = status;
  }

  const handoffs = await db.handoff.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
  });

  return NextResponse.json(handoffs);
}
