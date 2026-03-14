import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, proposeHandoffSchema } from '@/lib/validators';
import { validateBalance } from '@/lib/credits';
import { logAudit, getClientIp } from '@/lib/audit';

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const body = await request.json();
    const validated = validateBody(proposeHandoffSchema, body);
    if ('error' in validated) return validated.error;
    const data = validated.data;

    // Ensure authenticated agent is the proposer
    if (auth.agentId !== data.fromAgentId) {
      return NextResponse.json({ error: 'Cannot propose handoffs as another agent' }, { status: 403 });
    }

    // Verify channel exists
    const channel = await db.dMChannel.findUnique({ where: { id: data.channelId } });
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    // Balance check for priced handoffs
    if (data.price && data.price > 0) {
      const hasBalance = await validateBalance(data.fromAgentId, data.price);
      if (!hasBalance) {
        const agent = await db.agent.findUnique({ where: { id: data.fromAgentId }, select: { credits: true } });
        return NextResponse.json({
          error: 'Insufficient credits',
          balance: agent?.credits ?? 0,
          required: data.price,
        }, { status: 402 });
      }
    }

    const securityTier = data.securityTier || 'standard';
    const requiredTrust = data.requiredTrust || 'unverified';

    const handoff = await db.handoff.create({
      data: {
        fromAgentId: data.fromAgentId,
        fromAgentName: data.fromAgentName,
        toAgentId: data.toAgentId,
        toAgentName: data.toAgentName,
        channelId: data.channelId,
        status: 'proposed',
        task: {
          title: data.task.title,
          description: data.task.description,
          inputFormat: data.task.inputFormat,
          outputFormat: data.task.outputFormat,
        },
        price: data.price || null,
        securityTier,
        requiredTrust,
        dataPolicy: data.dataPolicy || null,
        auditLog: [{ action: 'proposed', agentId: data.fromAgentId, timestamp: new Date().toISOString() }],
      },
    });

    await db.directMessage.create({
      data: {
        channelId: data.channelId,
        fromAgentId: data.fromAgentId,
        fromAgentName: data.fromAgentName,
        toAgentId: data.toAgentId,
        toAgentName: data.toAgentName,
        message: `Handoff proposed: ${data.task.title}`,
        payload: {
          type: 'task_proposal',
          handoffId: handoff.id,
          task: data.task,
        },
      },
    });

    logAudit({
      agentId: auth.agentId,
      action: 'handoff.propose',
      resource: 'handoff',
      resourceId: handoff.id,
      metadata: { price: data.price, securityTier },
      ip: getClientIp(request),
    });

    return NextResponse.json(handoff, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
