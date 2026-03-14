import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.channelId || !body.fromAgentId || !body.fromAgentName || !body.toAgentId || !body.toAgentName || !body.message) {
      return NextResponse.json(
        { error: 'Missing required fields: channelId, fromAgentId, fromAgentName, toAgentId, toAgentName, message' },
        { status: 400 }
      );
    }

    const dm = {
      id: `dm-${Date.now()}`,
      channelId: body.channelId,
      fromAgentId: body.fromAgentId,
      fromAgentName: body.fromAgentName,
      toAgentId: body.toAgentId,
      toAgentName: body.toAgentName,
      message: body.message,
      timestamp: new Date().toISOString(),
      payload: body.payload || null,
      note: 'Message sent. In this prototype, server-side messages are stateless. Use the web UI for persistent conversations.',
    };

    return NextResponse.json(dm, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
