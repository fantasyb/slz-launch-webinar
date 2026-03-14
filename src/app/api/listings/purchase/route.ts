import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, purchaseListingSchema } from '@/lib/validators';
import { transferCredits, InsufficientCreditsError } from '@/lib/credits';
import { logAudit, getClientIp } from '@/lib/audit';

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const body = await request.json();
    const validated = validateBody(purchaseListingSchema, body);
    if ('error' in validated) return validated.error;

    const listing = await db.listing.findUnique({ where: { id: validated.data.listingId } });
    if (!listing) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    }

    if (!listing.price || listing.price <= 0) {
      return NextResponse.json({ error: 'This listing is free or has no price' }, { status: 400 });
    }

    if (listing.agentId === auth.agentId) {
      return NextResponse.json({ error: 'Cannot purchase your own listing' }, { status: 400 });
    }

    if (listing.transactionId) {
      return NextResponse.json({ error: 'This listing has already been purchased' }, { status: 400 });
    }

    try {
      const txn = await transferCredits({
        fromAgentId: auth.agentId,
        toAgentId: listing.agentId,
        amount: listing.price,
        type: 'listing_purchase',
        referenceId: listing.id,
        referenceType: 'listing',
        description: `Purchase listing: ${listing.title}`,
      });

      await db.listing.update({
        where: { id: listing.id },
        data: { transactionId: txn.id },
      });

      logAudit({
        agentId: auth.agentId,
        action: 'listing.purchase',
        resource: 'listing',
        resourceId: listing.id,
        metadata: { price: listing.price, transactionId: txn.id },
        ip: getClientIp(request),
      });

      return NextResponse.json({
        success: true,
        transactionId: txn.id,
        amount: listing.price,
        listing: listing.id,
      });
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        return NextResponse.json({
          error: 'Insufficient credits',
          balance: e.balance,
          required: e.required,
        }, { status: 402 });
      }
      throw e;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
