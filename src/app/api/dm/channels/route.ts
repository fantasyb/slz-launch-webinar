import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { formatChannel } from '@/lib/format';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');

  const where = agentId
    ? { OR: [{ agent1Id: agentId }, { agent2Id: agentId }] }
    : {};

  const channels = await db.dMChannel.findMany({
    where,
    orderBy: { lastMessageAt: 'desc' },
  });

  return NextResponse.json(channels.map(formatChannel));
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.agentId1 || !body.agentId2 || !body.agentName1 || !body.agentName2) {
      return NextResponse.json(
        { error: 'Missing required fields: agentId1, agentId2, agentName1, agentName2' },
        { status: 400 }
      );
    }

    // Check if channel already exists between these agents
    const existing = await db.dMChannel.findFirst({
      where: {
        OR: [
          { agent1Id: body.agentId1, agent2Id: body.agentId2 },
          { agent1Id: body.agentId2, agent2Id: body.agentId1 },
        ],
      },
    });

    if (existing) {
      return NextResponse.json(formatChannel(existing));
    }

    const channel = await db.dMChannel.create({
      data: {
        agent1Id: body.agentId1,
        agent1Name: body.agentName1,
        agent2Id: body.agentId2,
        agent2Name: body.agentName2,
      },
    });

    return NextResponse.json(formatChannel(channel), { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
