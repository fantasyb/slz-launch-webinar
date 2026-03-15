import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { searchMemories } from '@/lib/memory';

// GET /api/agentcy/memory — List memories, optionally filtered
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentSlug = searchParams.get('agentSlug') || undefined;
  const query = searchParams.get('q') || '';
  const type = searchParams.get('type') || undefined;
  const limit = parseInt(searchParams.get('limit') || '30');

  try {
    if (query) {
      // Semantic search
      const results = await searchMemories({
        agentSlug,
        query,
        types: type ? [type] : undefined,
        limit,
      });
      return NextResponse.json(results);
    }

    // Simple list
    const memories = await db.memory.findMany({
      where: {
        ...(agentSlug ? { agentSlug } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return NextResponse.json(memories);
  } catch {
    return NextResponse.json([]);
  }
}

// GET /api/agentcy/memory/daily — Get daily notes
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body as { action: string };

    if (action === 'daily-notes') {
      const { agentSlug, days } = body as { agentSlug?: string; days?: number };
      const notes = await db.dailyNote.findMany({
        where: agentSlug ? { agentSlug } : {},
        orderBy: { date: 'desc' },
        take: days || 7,
      });
      return NextResponse.json(notes);
    }

    if (action === 'stats') {
      const [totalMemories, byType, byAgent] = await Promise.all([
        db.memory.count(),
        db.memory.groupBy({ by: ['type'], _count: true }),
        db.memory.groupBy({ by: ['agentSlug'], _count: true }),
      ]);
      return NextResponse.json({ totalMemories, byType, byAgent });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
