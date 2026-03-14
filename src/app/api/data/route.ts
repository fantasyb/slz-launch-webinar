import { NextResponse } from 'next/server';
import { getListingsBySection } from '@/data/seed';

export async function GET() {
  return NextResponse.json(getListingsBySection('data'));
}
