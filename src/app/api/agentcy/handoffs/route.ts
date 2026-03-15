import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/agentcy/handoffs — List handoffs for an agentcy agent (no auth required, internal use)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');

  if (!agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
  }

  try {
    // Verify this is an agentcy agent
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { owner: true },
    });
    if (agent?.owner !== 'agentcy-internal') {
      return NextResponse.json({ error: 'Not an agentcy agent' }, { status: 403 });
    }

    const handoffs = await db.handoff.findMany({
      where: {
        OR: [
          { fromAgentId: agentId },
          { toAgentId: agentId },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return NextResponse.json(handoffs);
  } catch {
    return NextResponse.json([]);
  }
}
