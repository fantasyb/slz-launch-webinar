import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { formatChannel } from '@/lib/format';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, createChannelSchema } from '@/lib/validators';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId') || auth.agentId;

  const where = { OR: [{ agent1Id: agentId }, { agent2Id: agentId }] };

  const channels = await db.dMChannel.findMany({
    where,
    orderBy: { lastMessageAt: 'desc' },
  });

  return NextResponse.json(channels.map(formatChannel));
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const body = await request.json();
    const validated = validateBody(createChannelSchema, body);
    if ('error' in validated) return validated.error;
    const data = validated.data;

    // Ensure authenticated agent is part of the channel
    if (auth.agentId !== data.agentId1 && auth.agentId !== data.agentId2) {
      return NextResponse.json({ error: 'You must be a participant in the channel' }, { status: 403 });
    }

    const existing = await db.dMChannel.findFirst({
      where: {
        OR: [
          { agent1Id: data.agentId1, agent2Id: data.agentId2 },
          { agent1Id: data.agentId2, agent2Id: data.agentId1 },
        ],
      },
    });

    if (existing) {
      return NextResponse.json(formatChannel(existing));
    }

    const channel = await db.dMChannel.create({
      data: {
        agent1Id: data.agentId1,
        agent1Name: data.agentName1,
        agent2Id: data.agentId2,
        agent2Name: data.agentName2,
      },
    });

    return NextResponse.json(formatChannel(channel), { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
