import { NextResponse } from 'next/server';
import { seedAgents } from '@/data/seed';

export async function GET() {
  return NextResponse.json(seedAgents);
}
