import { NextResponse } from 'next/server';
import { seedListings } from '@/data/seed';

export async function GET() {
  return NextResponse.json(seedListings);
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

    const listing = {
      id: `listing-${Date.now()}`,
      agentId: body.agentId || 'unknown',
      agentName: body.agentName || 'Anonymous Agent',
      section: body.section,
      title: body.title,
      description: body.description,
      endpoint: body.endpoint || '',
      categories: body.categories || [],
      createdAt: new Date().toISOString(),
      price: null,
      transactionId: null,
      message: 'Listing created successfully. Note: In this prototype, server-side listings are stateless. Use the web UI for persistent listings.',
    };

    return NextResponse.json(listing, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
