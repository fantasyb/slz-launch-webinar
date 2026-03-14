import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, updateHandoffSchema } from '@/lib/validators';
import { transferCredits, validateBalance, checkAndAwardMilestones, InsufficientCreditsError } from '@/lib/credits';
import { logAudit, getClientIp } from '@/lib/audit';

const TRUST_LEVELS: Record<string, number> = {
  unverified: 0,
  verified: 1,
  trusted: 2,
  enterprise: 3,
};

function meetsMinTrust(agentTier: string, requiredTier: string): boolean {
  return (TRUST_LEVELS[agentTier] ?? 0) >= (TRUST_LEVELS[requiredTier] ?? 0);
}

const TRANSITIONS: Record<string, string[]> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['in_progress', 'rejected'],
  in_progress: ['delivered', 'rejected'],
  delivered: ['completed', 'rejected'],
};

async function appendAuditLog(handoffId: string, action: string, agentId: string) {
  const handoff = await db.handoff.findUnique({
    where: { id: handoffId },
    select: { auditLog: true },
  });
  const log = Array.isArray(handoff?.auditLog) ? handoff.auditLog as Array<Record<string, unknown>> : [];
  log.push({ action, agentId, timestamp: new Date().toISOString() });
  await db.handoff.update({
    where: { id: handoffId },
    data: { auditLog: log as unknown as import('@prisma/client').Prisma.InputJsonValue },
  });
}

async function updateAgentReputation(agentId: string) {
  const completedAsWorker = await db.handoff.findMany({
    where: { toAgentId: agentId, status: 'completed' },
    select: { rating: true, createdAt: true, completedAt: true },
  });

  const completedAsRequester = await db.handoff.findMany({
    where: { fromAgentId: agentId, status: 'completed' },
  });

  const totalCompleted = completedAsWorker.length + completedAsRequester.length;

  const rejectedAsWorker = await db.handoff.findMany({
    where: { toAgentId: agentId, status: 'rejected' },
  });

  const totalAttempted = completedAsWorker.length + rejectedAsWorker.length;
  const successRate = totalAttempted > 0
    ? Math.round((completedAsWorker.length / totalAttempted) * 100)
    : 0;

  const responseTimes = completedAsWorker
    .filter(h => h.completedAt)
    .map(h => h.completedAt!.getTime() - h.createdAt.getTime());
  const avgResponseTime = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : 0;

  const ratings = completedAsWorker
    .filter(h => h.rating != null)
    .map(h => h.rating!);
  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 0;

  const volumeScore = Math.min(completedAsWorker.length * 10, 50);
  const qualityScore = Math.round(avgRating * 10);
  const reliabilityBonus = successRate >= 90 ? 10 : successRate >= 75 ? 5 : 0;
  const reputationScore = Math.min(volumeScore + qualityScore + reliabilityBonus, 100);

  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { ownerVerified: true },
  });

  const trustTier = agent?.ownerVerified
    ? reputationScore >= 90
      ? 'enterprise'
      : reputationScore >= 70
        ? 'trusted'
        : 'verified'
    : 'unverified';

  await db.agent.update({
    where: { id: agentId },
    data: {
      tasksCompleted: totalCompleted,
      successRate,
      avgResponseTime,
      reputationScore,
      trustTier,
    },
  });

  return reputationScore;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const { id } = await params;
    const body = await request.json();
    const validated = validateBody(updateHandoffSchema, body);
    if ('error' in validated) return validated.error;
    const { action, agentId } = validated.data;

    // Ensure authenticated agent matches
    if (auth.agentId !== agentId) {
      return NextResponse.json({ error: 'Agent ID mismatch' }, { status: 403 });
    }

    const handoff = await db.handoff.findUnique({ where: { id } });
    if (!handoff) {
      return NextResponse.json({ error: 'Handoff not found' }, { status: 404 });
    }

    const isRequester = agentId === handoff.fromAgentId;
    const isWorker = agentId === handoff.toAgentId;

    if (!isRequester && !isWorker) {
      return NextResponse.json({ error: 'Agent not part of this handoff' }, { status: 403 });
    }

    switch (action) {
      case 'accept': {
        if (!isWorker) {
          return NextResponse.json({ error: 'Only the receiving agent can accept' }, { status: 403 });
        }
        if (!TRANSITIONS[handoff.status]?.includes('accepted')) {
          return NextResponse.json({ error: `Cannot accept from status: ${handoff.status}` }, { status: 400 });
        }

        const requiredTrust = (handoff.requiredTrust as string) || 'unverified';
        if (requiredTrust !== 'unverified') {
          const workerAgent = await db.agent.findUnique({ where: { id: agentId } });
          const workerTier = (workerAgent?.trustTier as string) || 'unverified';
          if (!meetsMinTrust(workerTier, requiredTrust)) {
            return NextResponse.json({
              error: `This handoff requires trust tier "${requiredTrust}" but your agent is "${workerTier}"`,
              hint: 'Verify your identity via /api/agents/verify to upgrade your trust tier',
              requiredTrust,
              currentTrust: workerTier,
            }, { status: 403 });
          }
        }

        // Re-validate requester balance on accept
        if (handoff.price && handoff.price > 0) {
          const hasBalance = await validateBalance(handoff.fromAgentId, handoff.price);
          if (!hasBalance) {
            return NextResponse.json({
              error: 'Requester has insufficient credits for this handoff',
            }, { status: 402 });
          }
        }

        const updated = await db.handoff.update({
          where: { id },
          data: { status: 'accepted' },
        });

        await appendAuditLog(id, 'accepted', agentId);

        await db.directMessage.create({
          data: {
            channelId: handoff.channelId,
            fromAgentId: agentId,
            fromAgentName: handoff.toAgentName,
            toAgentId: handoff.fromAgentId,
            toAgentName: handoff.fromAgentName,
            message: `Handoff accepted: ${(handoff.task as { title: string }).title}`,
            payload: { type: 'task_acceptance', handoffId: id },
          },
        });

        logAudit({
          agentId,
          action: 'handoff.accept',
          resource: 'handoff',
          resourceId: id,
          ip: getClientIp(request),
        });

        return NextResponse.json(updated);
      }

      case 'start': {
        if (!isWorker) {
          return NextResponse.json({ error: 'Only the receiving agent can start work' }, { status: 403 });
        }
        if (!TRANSITIONS[handoff.status]?.includes('in_progress')) {
          return NextResponse.json({ error: `Cannot start from status: ${handoff.status}` }, { status: 400 });
        }

        const updated = await db.handoff.update({
          where: { id },
          data: { status: 'in_progress' },
        });

        await appendAuditLog(id, 'started', agentId);

        await db.directMessage.create({
          data: {
            channelId: handoff.channelId,
            fromAgentId: agentId,
            fromAgentName: handoff.toAgentName,
            toAgentId: handoff.fromAgentId,
            toAgentName: handoff.fromAgentName,
            message: `Work started on: ${(handoff.task as { title: string }).title}`,
            payload: { type: 'status_update', handoffId: id, status: 'in_progress' },
          },
        });

        return NextResponse.json(updated);
      }

      case 'deliver': {
        if (!isWorker) {
          return NextResponse.json({ error: 'Only the receiving agent can deliver' }, { status: 403 });
        }
        if (!TRANSITIONS[handoff.status]?.includes('delivered')) {
          return NextResponse.json({ error: `Cannot deliver from status: ${handoff.status}` }, { status: 400 });
        }

        const updated = await db.handoff.update({
          where: { id },
          data: {
            status: 'delivered',
            result: validated.data.result || null,
            deliveredAt: new Date(),
          },
        });

        await appendAuditLog(id, 'delivered', agentId);

        await db.directMessage.create({
          data: {
            channelId: handoff.channelId,
            fromAgentId: agentId,
            fromAgentName: handoff.toAgentName,
            toAgentId: handoff.fromAgentId,
            toAgentName: handoff.fromAgentName,
            message: validated.data.message || `Result delivered for: ${(handoff.task as { title: string }).title}`,
            payload: {
              type: 'result_delivery',
              handoffId: id,
              result: validated.data.result || null,
            },
          },
        });

        return NextResponse.json(updated);
      }

      case 'complete': {
        if (!isRequester) {
          return NextResponse.json({ error: 'Only the requesting agent can confirm completion' }, { status: 403 });
        }
        if (!TRANSITIONS[handoff.status]?.includes('completed')) {
          return NextResponse.json({ error: `Cannot complete from status: ${handoff.status}` }, { status: 400 });
        }

        const rating = validated.data.rating ? Math.min(5, Math.max(1, Math.round(validated.data.rating))) : null;

        await db.handoff.update({
          where: { id },
          data: {
            status: 'completed',
            rating,
            review: validated.data.review || null,
            completedAt: new Date(),
          },
        });

        // Add peer review
        if (rating) {
          const worker = await db.agent.findUnique({ where: { id: handoff.toAgentId } });
          if (worker) {
            const reviews = Array.isArray(worker.peerReviews) ? worker.peerReviews as Array<Record<string, unknown>> : [];
            reviews.unshift({
              agentId: handoff.fromAgentId,
              agentName: handoff.fromAgentName,
              rating,
              comment: validated.data.review || `Completed: ${(handoff.task as { title: string }).title}`,
              handoffId: id,
              date: new Date().toISOString(),
            });

            await db.agent.update({
              where: { id: handoff.toAgentId },
              data: { peerReviews: reviews as unknown as import('@prisma/client').Prisma.InputJsonValue },
            });
          }
        }

        await db.directMessage.create({
          data: {
            channelId: handoff.channelId,
            fromAgentId: agentId,
            fromAgentName: handoff.fromAgentName,
            toAgentId: handoff.toAgentId,
            toAgentName: handoff.toAgentName,
            message: `Handoff completed${rating ? ` (${rating}/5 stars)` : ''}: ${(handoff.task as { title: string }).title}`,
            payload: { type: 'status_update', handoffId: id, status: 'completed' },
          },
        });

        await appendAuditLog(id, 'completed', agentId);

        // ATOMIC credit transfer (replaces the old non-atomic two-update approach)
        let transactionId: string | null = null;
        if (handoff.price && handoff.price > 0) {
          try {
            const txn = await transferCredits({
              fromAgentId: handoff.fromAgentId,
              toAgentId: handoff.toAgentId,
              amount: handoff.price,
              type: 'handoff_payment',
              referenceId: id,
              referenceType: 'handoff',
              description: `Payment for handoff: ${(handoff.task as { title: string }).title}`,
            });
            transactionId = txn.id;
            await db.handoff.update({
              where: { id },
              data: { transactionId },
            });
            await appendAuditLog(id, `payment_processed:${handoff.price}credits:${transactionId}`, 'system');
          } catch (e) {
            if (e instanceof InsufficientCreditsError) {
              return NextResponse.json({
                error: 'Payment failed: insufficient credits',
                balance: e.balance,
                required: e.required,
              }, { status: 402 });
            }
            throw e;
          }
        }

        // Update reputation for both agents
        const workerRep = await updateAgentReputation(handoff.toAgentId);
        await updateAgentReputation(handoff.fromAgentId);

        // Check and award reputation milestone bonuses
        await checkAndAwardMilestones(handoff.toAgentId, workerRep);

        logAudit({
          agentId,
          action: 'handoff.complete',
          resource: 'handoff',
          resourceId: id,
          metadata: { rating, transactionId, price: handoff.price },
          ip: getClientIp(request),
        });

        const finalHandoff = await db.handoff.findUnique({ where: { id } });
        return NextResponse.json(finalHandoff);
      }

      case 'reject': {
        if (!TRANSITIONS[handoff.status]?.includes('rejected')) {
          return NextResponse.json({ error: `Cannot reject from status: ${handoff.status}` }, { status: 400 });
        }

        const updated = await db.handoff.update({
          where: { id },
          data: { status: 'rejected' },
        });

        await appendAuditLog(id, 'rejected', agentId);

        const rejecterName = isRequester ? handoff.fromAgentName : handoff.toAgentName;
        const otherAgentId = isRequester ? handoff.toAgentId : handoff.fromAgentId;
        const otherAgentName = isRequester ? handoff.toAgentName : handoff.fromAgentName;

        await db.directMessage.create({
          data: {
            channelId: handoff.channelId,
            fromAgentId: agentId,
            fromAgentName: rejecterName,
            toAgentId: otherAgentId,
            toAgentName: otherAgentName,
            message: validated.data.reason || `Handoff rejected: ${(handoff.task as { title: string }).title}`,
            payload: { type: 'status_update', handoffId: id, status: 'rejected' },
          },
        });

        if (handoff.status === 'in_progress' || handoff.status === 'delivered') {
          await updateAgentReputation(handoff.toAgentId);
        }

        logAudit({
          agentId,
          action: 'handoff.reject',
          resource: 'handoff',
          resourceId: id,
          ip: getClientIp(request),
        });

        return NextResponse.json(updated);
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid: accept, start, deliver, complete, reject` },
          { status: 400 }
        );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request);
  if (isAuthResponse(auth)) return auth;

  const { id } = await params;
  const handoff = await db.handoff.findUnique({ where: { id } });

  if (!handoff) {
    return NextResponse.json({ error: 'Handoff not found' }, { status: 404 });
  }

  // Ensure authenticated agent is a participant
  if (handoff.fromAgentId !== auth.agentId && handoff.toAgentId !== auth.agentId) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  return NextResponse.json(handoff);
}
