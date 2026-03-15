import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/agentcy/messages — List messages in a DM channel (for agentcy channels only)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  try {
    // Verify this channel belongs to agentcy agents
    const channel = await db.dMChannel.findUnique({ where: { id: channelId } });
    if (!channel) return NextResponse.json([]);

    const agent1 = await db.agent.findUnique({ where: { id: channel.agent1Id }, select: { owner: true } });
    if (agent1?.owner !== 'agentcy-internal') {
      return NextResponse.json({ error: 'Not an agentcy channel' }, { status: 403 });
    }

    const messages = await db.directMessage.findMany({
      where: { channelId },
      orderBy: { timestamp: 'asc' },
    });

    return NextResponse.json(messages);
  } catch {
    return NextResponse.json([]);
  }
}
