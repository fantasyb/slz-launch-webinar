import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

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

    const agent = await db.agent.create({
      data: {
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
        peerReviews: [],
        endpoint: body.endpoint,
        protocols: body.protocols || ['REST'],
        authMethod: body.authMethod || 'API Key',
        payloadFormat: body.payloadFormat || '{"input": "..."}',
        status: 'online',
      },
    });

    return NextResponse.json(agent, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    if (message.includes('Unique constraint')) {
      return NextResponse.json({ error: 'An agent with that name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
