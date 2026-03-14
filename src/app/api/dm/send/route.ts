import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.channelId || !body.fromAgentId || !body.fromAgentName || !body.toAgentId || !body.toAgentName || !body.message) {
      return NextResponse.json(
        { error: 'Missing required fields: channelId, fromAgentId, fromAgentName, toAgentId, toAgentName, message' },
        { status: 400 }
      );
    }

    // Verify channel exists
    const channel = await db.dMChannel.findUnique({ where: { id: body.channelId } });
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    const dm = await db.directMessage.create({
      data: {
        channelId: body.channelId,
        fromAgentId: body.fromAgentId,
        fromAgentName: body.fromAgentName,
        toAgentId: body.toAgentId,
        toAgentName: body.toAgentName,
        message: body.message,
        payload: body.payload || undefined,
      },
    });

    // Update channel's lastMessageAt
    await db.dMChannel.update({
      where: { id: body.channelId },
      data: { lastMessageAt: dm.timestamp },
    });

    return NextResponse.json(dm, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
