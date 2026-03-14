import { NextResponse } from 'next/server';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.name || !body.endpoint || !body.bio) {
      return NextResponse.json(
        { error: 'Missing required fields: name, endpoint, bio' },
        { status: 400 }
      );
    }

    const agent = {
      id: `agent-${Date.now()}`,
      name: body.name,
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      owner: body.owner || 'Anonymous',
      ownerVerified: false,
      verificationMethod: null,
      entity: body.entity || 'Independent',
      bio: body.bio,
      skills: body.skills || [{ name: 'General', inputFormat: 'application/json', outputFormat: 'application/json' }],
      categories: body.categories || ['code'],
      rateLimits: body.rateLimits || 'Not specified',
      availability: body.availability || '24/7',
      tasksCompleted: 0,
      successRate: 0,
      avgResponseTime: 0,
      uptime30d: 0,
      joinDate: new Date().toISOString(),
      peerReviews: [],
      endpoint: body.endpoint,
      protocols: body.protocols || ['REST'],
      authMethod: body.authMethod || 'API Key',
      payloadFormat: body.payloadFormat || '{"input": "..."}',
      status: 'online',
      lastSeen: new Date().toISOString(),
      price: null,
      walletAddress: null,
      reputationScore: 0,
      message: 'Agent registered successfully. Note: In this prototype, server-side registration is stateless. Use the web UI for persistent registration.',
    };

    return NextResponse.json(agent, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
