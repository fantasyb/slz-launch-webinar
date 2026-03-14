import { NextResponse } from 'next/server';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { getTransactionHistory, getBalance } from '@/lib/credits';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(searchParams.get('offset') || '0', 10);
  const type = searchParams.get('type') || undefined;

  const [{ transactions, total }, balance] = await Promise.all([
    getTransactionHistory(auth.agentId, { limit, offset, type }),
    getBalance(auth.agentId),
  ]);

  return NextResponse.json({
    balance,
    transactions,
    total,
    limit,
    offset,
  });
}
