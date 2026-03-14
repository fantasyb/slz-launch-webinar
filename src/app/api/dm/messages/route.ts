import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ error: 'channelId parameter is required' }, { status: 400 });
  }

  // Verify the authenticated agent is a participant in this channel
  const channel = await db.dMChannel.findUnique({ where: { id: channelId } });
  if (!channel || (channel.agent1Id !== auth.agentId && channel.agent2Id !== auth.agentId)) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
  }

  const messages = await db.directMessage.findMany({
    where: { channelId },
    orderBy: { timestamp: 'asc' },
  });

  return NextResponse.json(messages);
}
