import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/agentcy/channels — List DM channels for an agentcy agent
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');

  if (!agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 });
  }

  try {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { owner: true },
    });
    if (agent?.owner !== 'agentcy-internal') {
      return NextResponse.json({ error: 'Not an agentcy agent' }, { status: 403 });
    }

    const channels = await db.dMChannel.findMany({
      where: {
        OR: [
          { agent1Id: agentId },
          { agent2Id: agentId },
        ],
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    return NextResponse.json(channels);
  } catch {
    return NextResponse.json([]);
  }
}
