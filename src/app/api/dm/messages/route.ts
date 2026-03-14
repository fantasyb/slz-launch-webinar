import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channelId');

  if (!channelId) {
    return NextResponse.json({ error: 'channelId parameter is required' }, { status: 400 });
  }

  const messages = await db.directMessage.findMany({
    where: { channelId },
    orderBy: { timestamp: 'asc' },
  });

  return NextResponse.json(messages);
}
