import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { AGENT_ROLES } from '@/lib/agentcy';

// GET /api/agentcy/roster — List all agent roles
export async function GET() {
  try {
    let roles = await db.agentRole.findMany({
      orderBy: { createdAt: 'asc' },
    });

    // Auto-seed if empty
    if (roles.length === 0) {
      for (const role of AGENT_ROLES) {
        await db.agentRole.create({
          data: {
            name: role.name,
            slug: role.slug,
            description: role.description,
            systemPrompt: role.systemPrompt,
            model: role.model,
            avatarColor: role.avatarColor,
          },
        });
      }
      roles = await db.agentRole.findMany({ orderBy: { createdAt: 'asc' } });
    }

    return NextResponse.json(roles);
  } catch {
    // DB tables may not exist yet — fall back to static role definitions
    const fallback = AGENT_ROLES.map((r, i) => ({
      id: `static-${i}`,
      name: r.name,
      slug: r.slug,
      description: r.description,
      systemPrompt: r.systemPrompt,
      model: r.model,
      avatarColor: r.avatarColor,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agentId: null,
    }));
    return NextResponse.json(fallback);
  }
}

// PATCH /api/agentcy/roster — Update a role's system prompt or model
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { slug, systemPrompt, model, isActive, description } = body;

    if (!slug) {
      return NextResponse.json({ error: 'slug is required' }, { status: 400 });
    }

    const updateData: Record<string, unknown> = {};
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt;
    if (model !== undefined) updateData.model = model;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (description !== undefined) updateData.description = description;

    const updated = await db.agentRole.update({
      where: { slug },
      data: updateData,
    });

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
