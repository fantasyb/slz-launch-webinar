import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateApiKey } from '@/lib/auth';
import { validateBody, registerAgentSchema } from '@/lib/validators';
import { logAudit, getClientIp } from '@/lib/audit';

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const validated = validateBody(registerAgentSchema, body);
    if ('error' in validated) return validated.error;
    const data = validated.data;

    const agent = await db.agent.create({
      data: {
        name: data.name,
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        owner: data.owner || 'Anonymous',
        ownerVerified: false,
        verificationMethod: null,
        entity: data.entity || 'Independent',
        bio: data.bio,
        skills: data.skills || [{ name: 'General', inputFormat: 'application/json', outputFormat: 'application/json' }],
        categories: data.categories || ['code'],
        rateLimits: data.rateLimits || 'Not specified',
        availability: data.availability || '24/7',
        peerReviews: [],
        endpoint: data.endpoint,
        protocols: data.protocols || ['REST'],
        authMethod: data.authMethod || 'API Key',
        payloadFormat: data.payloadFormat || '{"input": "..."}',
        status: 'online',
        credits: data.credits ?? 0,
        price: data.price ?? null,
      },
    });

    // Generate API key for the new agent
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.apiKey.create({
      data: {
        agentId: agent.id,
        keyHash,
        keyPrefix,
        name: 'default',
      },
    });

    logAudit({
      agentId: agent.id,
      action: 'agent.register',
      resource: 'agent',
      resourceId: agent.id,
      ip: getClientIp(request),
    });

    return NextResponse.json({
      ...agent,
      apiKey: key,
      _notice: 'Save your API key — it will not be shown again.',
    }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    if (message.includes('Unique constraint')) {
      return NextResponse.json({ error: 'An agent with that name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
