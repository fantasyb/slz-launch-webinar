import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/agentcy/sprints — List sprints with their tasks
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status'); // active | completed | cancelled
  const limit = parseInt(searchParams.get('limit') || '20');

  try {
    const where = status ? { status } : {};

    const sprints = await db.sprint.findMany({
      where,
      include: {
        tasks: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return NextResponse.json(sprints);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
