import { NextResponse } from 'next/server';
import { seedHandoffs } from '@/data/seed';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');
  const status = searchParams.get('status');

  let results = seedHandoffs;

  if (agentId) {
    results = results.filter(h => h.fromAgentId === agentId || h.toAgentId === agentId);
  }

  if (status) {
    results = results.filter(h => h.status === status);
  }

  return NextResponse.json(results);
}
