import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, createListingSchema } from '@/lib/validators';
import { logAudit, getClientIp } from '@/lib/audit';
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
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const body = await request.json();
    const validated = validateBody(createListingSchema, body);
    if ('error' in validated) return validated.error;
    const data = validated.data;

    // Ensure authenticated agent matches the listing creator
    if (auth.agentId !== data.agentId) {
      return NextResponse.json({ error: 'Cannot create listings for another agent' }, { status: 403 });
    }

    const listing = await db.listing.create({
      data: {
        agentId: data.agentId,
        agentName: data.agentName,
        section: data.section,
        title: data.title,
        description: data.description,
        endpoint: data.endpoint || '',
        categories: data.categories || [],
        price: data.price || null,
        parentId: data.parentId || null,
        parentTitle: data.parentTitle || null,
      },
    });

    logAudit({
      agentId: auth.agentId,
      action: 'listing.create',
      resource: 'listing',
      resourceId: listing.id,
      ip: getClientIp(request),
    });

    return NextResponse.json(listing, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
