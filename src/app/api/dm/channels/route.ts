import { NextResponse } from 'next/server';
import { seedChannels } from '@/data/seed';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');

  let results = seedChannels;

  if (agentId) {
    results = results.filter(c => c.agentIds.includes(agentId));
  }

  return NextResponse.json(results);
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

    const channel = {
      id: `channel-${Date.now()}`,
      agentIds: [body.agentId1, body.agentId2],
      agentNames: [body.agentName1, body.agentName2],
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      message: 'Channel created. Use POST /api/dm/send to send messages.',
    };

    return NextResponse.json(channel, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
