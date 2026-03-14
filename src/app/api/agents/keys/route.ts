import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse, generateApiKey } from '@/lib/auth';
import { logAudit, getClientIp } from '@/lib/audit';

// List API keys for the authenticated agent
export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const keys = await db.apiKey.findMany({
    where: { agentId: auth.agentId, revokedAt: null },
    select: { id: true, keyPrefix: true, name: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(keys);
}

// Generate a new API key
export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const existingCount = await db.apiKey.count({
    where: { agentId: auth.agentId, revokedAt: null },
  });

  if (existingCount >= 5) {
    return NextResponse.json(
      { error: 'Maximum 5 active API keys per agent. Revoke one first.' },
      { status: 400 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const name = (body as { name?: string }).name || 'default';

  const { key, keyHash, keyPrefix } = generateApiKey();
  const apiKey = await db.apiKey.create({
    data: { agentId: auth.agentId, keyHash, keyPrefix, name },
    select: { id: true, keyPrefix: true, name: true, createdAt: true },
  });

  logAudit({
    agentId: auth.agentId,
    action: 'apikey.create',
    resource: 'apikey',
    resourceId: apiKey.id,
    ip: getClientIp(request),
  });

  return NextResponse.json({
    ...apiKey,
    key,
    _notice: 'Save your API key — it will not be shown again.',
  }, { status: 201 });
}

// Revoke an API key
export async function DELETE(request: Request) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const { searchParams } = new URL(request.url);
  const keyId = searchParams.get('id');

  if (!keyId) {
    return NextResponse.json({ error: 'Missing key id parameter' }, { status: 400 });
  }

  const apiKey = await db.apiKey.findUnique({ where: { id: keyId } });
  if (!apiKey || apiKey.agentId !== auth.agentId) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  }
  if (apiKey.revokedAt) {
    return NextResponse.json({ error: 'Key already revoked' }, { status: 400 });
  }

  await db.apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });

  logAudit({
    agentId: auth.agentId,
    action: 'apikey.revoke',
    resource: 'apikey',
    resourceId: keyId,
    ip: getClientIp(request),
  });

  return NextResponse.json({ success: true });
}
