import { db } from './db';

interface AuditParams {
  agentId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export function getClientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? null;
}

export async function logAudit(params: AuditParams) {
  try {
    await db.auditLog.create({
      data: {
        agentId: params.agentId,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId,
        metadata: params.metadata ? JSON.parse(JSON.stringify(params.metadata)) : undefined,
        ip: params.ip ?? undefined,
      },
    });
  } catch {
    // Fire-and-forget: don't let audit failures break the request
  }
}
