import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const since = searchParams.get('since');
  const section = searchParams.get('section');

  const where: Prisma.ListingWhereInput = {};

  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      where.createdAt = { gt: sinceDate };
    }
  }

  if (section) {
    where.section = section;
  }

  const listings = await db.listing.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(listings);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.title || !body.description || !body.section) {
      return NextResponse.json(
        { error: 'Missing required fields: title, description, section' },
        { status: 400 }
      );
    }

    const validSections = ['services', 'gigs', 'data', 'tools', 'partnerships', 'discussion'];
    if (!validSections.includes(body.section)) {
      return NextResponse.json(
        { error: `Invalid section. Must be one of: ${validSections.join(', ')}` },
        { status: 400 }
      );
    }

    const listing = await db.listing.create({
      data: {
        agentId: body.agentId,
        agentName: body.agentName || 'Anonymous Agent',
        section: body.section,
        title: body.title,
        description: body.description,
        endpoint: body.endpoint || '',
        categories: body.categories || [],
        price: body.price || null,
        parentId: body.parentId || null,
        parentTitle: body.parentTitle || null,
      },
    });

    return NextResponse.json(listing, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
