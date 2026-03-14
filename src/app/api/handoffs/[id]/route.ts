import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Trust tier hierarchy (higher index = more trusted)
const TRUST_LEVELS: Record<string, number> = {
  unverified: 0,
  verified: 1,
  trusted: 2,
  enterprise: 3,
};

function meetsMinTrust(agentTier: string, requiredTier: string): boolean {
  return (TRUST_LEVELS[agentTier] ?? 0) >= (TRUST_LEVELS[requiredTier] ?? 0);
}

// Valid status transitions
const TRANSITIONS: Record<string, string[]> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['in_progress', 'rejected'],
  in_progress: ['delivered', 'rejected'],
  delivered: ['completed', 'rejected'],
};

// Append an entry to a handoff's audit log
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

// Recalculate and update an agent's reputation from all their completed handoffs
async function updateAgentReputation(agentId: string) {
  // Get all handoffs where this agent was the worker (toAgent)
  const completedAsWorker = await db.handoff.findMany({
    where: { toAgentId: agentId, status: 'completed' },
    select: { rating: true, createdAt: true, completedAt: true },
  });

  // Get all handoffs where this agent was the requester (fromAgent)
  const completedAsRequester = await db.handoff.findMany({
    where: { fromAgentId: agentId, status: 'completed' },
  });

  const totalCompleted = completedAsWorker.length + completedAsRequester.length;

  // Get rejected/failed handoffs for this agent as worker
  const rejectedAsWorker = await db.handoff.findMany({
    where: { toAgentId: agentId, status: 'rejected' },
  });

  const totalAttempted = completedAsWorker.length + rejectedAsWorker.length;
  const successRate = totalAttempted > 0
    ? Math.round((completedAsWorker.length / totalAttempted) * 100)
    : 0;

  // Average response time (time from creation to completion) in ms
  const responseTimes = completedAsWorker
    .filter(h => h.completedAt)
    .map(h => h.completedAt!.getTime() - h.createdAt.getTime());
  const avgResponseTime = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : 0;

  // Reputation score: weighted formula
  // - Base: 10 points per completed task (as worker), max 50 from volume
  // - Rating: average rating * 10, max 50 from quality
  const ratings = completedAsWorker
    .filter(h => h.rating != null)
    .map(h => h.rating!);
  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : 0;

  const volumeScore = Math.min(completedAsWorker.length * 10, 50);
  const qualityScore = Math.round(avgRating * 10); // 0-50
  const reliabilityBonus = successRate >= 90 ? 10 : successRate >= 75 ? 5 : 0;
  const reputationScore = Math.min(volumeScore + qualityScore + reliabilityBonus, 100);

  // Determine trust tier based on verification status and reputation
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
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { action, agentId } = body;

    if (!action || !agentId) {
      return NextResponse.json(
        { error: 'Missing required fields: action, agentId' },
        { status: 400 }
      );
    }

    const handoff = await db.handoff.findUnique({ where: { id } });
    if (!handoff) {
      return NextResponse.json({ error: 'Handoff not found' }, { status: 404 });
    }

    // Validate who can do what
    const isRequester = agentId === handoff.fromAgentId;
    const isWorker = agentId === handoff.toAgentId;

    if (!isRequester && !isWorker) {
      return NextResponse.json({ error: 'Agent not part of this handoff' }, { status: 403 });
    }

    switch (action) {
      case 'accept': {
        // Worker accepts the proposal
        if (!isWorker) {
          return NextResponse.json({ error: 'Only the receiving agent can accept' }, { status: 403 });
        }
        if (!TRANSITIONS[handoff.status]?.includes('accepted')) {
          return NextResponse.json({ error: `Cannot accept from status: ${handoff.status}` }, { status: 400 });
        }

        // Enforce trust tier requirements
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

        return NextResponse.json(updated);
      }

      case 'start': {
        // Worker starts working
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
        // Worker delivers result
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
            result: body.result || null,
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
            message: body.message || `Result delivered for: ${(handoff.task as { title: string }).title}`,
            payload: {
              type: 'result_delivery',
              handoffId: id,
              result: body.result || null,
            },
          },
        });

        return NextResponse.json(updated);
      }

      case 'complete': {
        // Requester confirms completion + rates
        if (!isRequester) {
          return NextResponse.json({ error: 'Only the requesting agent can confirm completion' }, { status: 403 });
        }
        if (!TRANSITIONS[handoff.status]?.includes('completed')) {
          return NextResponse.json({ error: `Cannot complete from status: ${handoff.status}` }, { status: 400 });
        }

        const rating = body.rating ? Math.min(5, Math.max(1, Math.round(body.rating))) : null;

        await db.handoff.update({
          where: { id },
          data: {
            status: 'completed',
            rating,
            review: body.review || null,
            completedAt: new Date(),
          },
        });

        // Add peer review to the worker's profile
        if (rating) {
          const worker = await db.agent.findUnique({ where: { id: handoff.toAgentId } });
          if (worker) {
            const reviews = Array.isArray(worker.peerReviews) ? worker.peerReviews as Array<Record<string, unknown>> : [];
            reviews.unshift({
              agentId: handoff.fromAgentId,
              agentName: handoff.fromAgentName,
              rating,
              comment: body.review || `Completed: ${(handoff.task as { title: string }).title}`,
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

        // Process mock payment: transfer credits from requester to worker
        let transactionId: string | null = null;
        if (handoff.price && handoff.price > 0) {
          transactionId = `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await db.agent.update({
            where: { id: handoff.fromAgentId },
            data: { credits: { decrement: handoff.price } },
          });
          await db.agent.update({
            where: { id: handoff.toAgentId },
            data: { credits: { increment: handoff.price } },
          });
          await db.handoff.update({
            where: { id },
            data: { transactionId },
          });
          await appendAuditLog(id, `payment_processed:${handoff.price}credits:${transactionId}`, 'system');
        }

        // Update reputation for both agents
        await updateAgentReputation(handoff.toAgentId);
        await updateAgentReputation(handoff.fromAgentId);

        const finalHandoff = await db.handoff.findUnique({ where: { id } });
        return NextResponse.json(finalHandoff);
      }

      case 'reject': {
        // Either party can reject
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
            message: body.reason || `Handoff rejected: ${(handoff.task as { title: string }).title}`,
            payload: { type: 'status_update', handoffId: id, status: 'rejected' },
          },
        });

        // Update reputation (rejection counts against worker)
        if (handoff.status === 'in_progress' || handoff.status === 'delivered') {
          await updateAgentReputation(handoff.toAgentId);
        }

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

// GET a single handoff
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const handoff = await db.handoff.findUnique({ where: { id } });

  if (!handoff) {
    return NextResponse.json({ error: 'Handoff not found' }, { status: 404 });
  }

  return NextResponse.json(handoff);
}
