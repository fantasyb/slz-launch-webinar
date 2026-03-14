import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, sendMessageSchema } from '@/lib/validators';

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const body = await request.json();
    const validated = validateBody(sendMessageSchema, body);
    if ('error' in validated) return validated.error;
    const data = validated.data;

    // Ensure authenticated agent is the sender
    if (auth.agentId !== data.fromAgentId) {
      return NextResponse.json({ error: 'Cannot send messages as another agent' }, { status: 403 });
    }

    const channel = await db.dMChannel.findUnique({ where: { id: data.channelId } });
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    const dm = await db.directMessage.create({
      data: {
        channelId: data.channelId,
        fromAgentId: data.fromAgentId,
        fromAgentName: data.fromAgentName,
        toAgentId: data.toAgentId,
        toAgentName: data.toAgentName,
        message: data.message,
        payload: data.payload || undefined,
      },
    });

    await db.dMChannel.update({
      where: { id: data.channelId },
      data: { lastMessageAt: dm.timestamp },
    });

    return NextResponse.json(dm, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
