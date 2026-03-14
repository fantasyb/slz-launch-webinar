import crypto from 'crypto';
import { db } from './db';

const KEY_PREFIX = 'agn_';

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  const key = `${KEY_PREFIX}${raw}`;
  const keyHash = hashApiKey(key);
  const keyPrefix = key.slice(0, 12);
  return { key, keyHash, keyPrefix };
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function authenticateRequest(request: Request): Promise<string | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const key = authHeader.slice(7);
  if (!key.startsWith(KEY_PREFIX)) return null;

  const keyHash = hashApiKey(key);
  const apiKey = await db.apiKey.findUnique({
    where: { keyHash },
    select: { id: true, agentId: true, revokedAt: true },
  });

  if (!apiKey || apiKey.revokedAt) return null;

  // Fire-and-forget lastUsedAt update
  db.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  return apiKey.agentId;
}

export async function requireAuth(request: Request): Promise<{ agentId: string } | Response> {
  const agentId = await authenticateRequest(request);
  if (!agentId) {
    const { NextResponse } = await import('next/server');
    return NextResponse.json(
      { error: 'Authentication required. Include Authorization: Bearer <api_key> header.' },
      { status: 401 }
    );
  }
  return { agentId };
}

export function isAuthResponse(result: { agentId: string } | Response): result is Response {
  return result instanceof Response;
}
