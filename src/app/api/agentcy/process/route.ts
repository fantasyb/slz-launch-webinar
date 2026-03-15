import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { AGENT_ROLES, executeAgent, type ExecutionResult } from '@/lib/agentcy';
import { getAgentIdMap } from '@/lib/agentcy-setup';
import { buildMemoryContext, extractMemories, writeMemories, appendDailyNote, type MemoryWrite } from '@/lib/memory';

// POST /api/agentcy/process — Process a handoff: accept → start → execute with Claude → deliver
// This is the internal "brain" that makes agentcy agents work
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const body = await request.json();
        const { handoffId, skipQA } = body as { handoffId: string; skipQA?: boolean };

        if (!handoffId) {
          send('error', { error: 'handoffId is required' });
          controller.close();
          return;
        }

        // Get the handoff
        const handoff = await db.handoff.findUnique({ where: { id: handoffId } });
        if (!handoff) {
          send('error', { error: 'Handoff not found' });
          controller.close();
          return;
        }

        const task = handoff.task as { title: string; description: string };
        const agentIdMap = await getAgentIdMap();

        // Find which role this handoff is assigned to
        const workerAgent = await db.agent.findUnique({
          where: { id: handoff.toAgentId },
          select: { name: true },
        });
        if (!workerAgent) {
          send('error', { error: 'Worker agent not found' });
          controller.close();
          return;
        }

        const roleName = workerAgent.name.replace('Agentcy: ', '');
        const role = AGENT_ROLES.find(r => r.name === roleName);
        if (!role) {
          send('error', { error: `No role definition found for: ${roleName}` });
          controller.close();
          return;
        }

        // Step 1: Accept the handoff
        if (handoff.status === 'proposed') {
          await db.handoff.update({ where: { id: handoffId }, data: { status: 'accepted' } });
          await createDM(handoff.channelId, handoff.toAgentId, workerAgent.name, handoff.fromAgentId, handoff.fromAgentName,
            `Handoff accepted: ${task.title}`, { type: 'task_acceptance', handoffId });
          send('status', { message: `${role.name} accepted the handoff` });
        }

        // Step 2: Start work
        await db.handoff.update({ where: { id: handoffId }, data: { status: 'in_progress' } });
        await createDM(handoff.channelId, handoff.toAgentId, workerAgent.name, handoff.fromAgentId, handoff.fromAgentName,
          `Working on: ${task.title}`, { type: 'status_update', handoffId, status: 'in_progress' });
        send('status', { message: `${role.name} is working on: ${task.title}...` });

        // Step 3: Retrieve relevant memories for context
        send('status', { message: `${role.name} is recalling relevant context...` });
        let memoryContext = '';
        try {
          memoryContext = await buildMemoryContext(role.slug, task.title, task.description);
        } catch {
          // Memory retrieval is non-critical — proceed without it
        }

        // Step 4: Execute with Claude (with tools if the role has them)
        const taskMessage = memoryContext
          ? `${memoryContext}\n\n---\n\n## Task: ${task.title}\n\n${task.description}`
          : `## Task: ${task.title}\n\n${task.description}`;

        const result = await executeAgent(
          role.systemPrompt,
          taskMessage,
          role.model,
          4096,
          role.tools,
          role.toolHandler,
        );

        send('agent_done', {
          output: result.output,
          tokens: result.inputTokens + result.outputTokens,
          cost: result.costUsd,
          latency: result.latencyMs,
          toolCalls: result.toolCalls?.length || 0,
        });

        // Step 4: Deliver the result through the handoff system
        await db.handoff.update({
          where: { id: handoffId },
          data: {
            status: 'delivered',
            result: JSON.parse(JSON.stringify({
              format: 'text/markdown',
              content: result.output,
              metadata: {
                model: result.model,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                costUsd: result.costUsd,
                latencyMs: result.latencyMs,
                toolCalls: result.toolCalls || [],
              },
            })),
            deliveredAt: new Date(),
          },
        });

        await createDM(handoff.channelId, handoff.toAgentId, workerAgent.name, handoff.fromAgentId, handoff.fromAgentName,
          `Delivered result for: ${task.title}`, {
            type: 'result_delivery',
            handoffId,
            result: { format: 'text/markdown', content: result.output },
          });

        send('delivered', { handoffId, output: result.output });

        // Step 5: QA Review (if not skipped)
        if (!skipQA && role.slug !== 'qa-editor') {
          send('status', { message: 'QA Editor is reviewing...' });

          const qaRole = AGENT_ROLES.find(r => r.slug === 'qa-editor')!;
          const qaAgentId = agentIdMap['qa-editor'];

          const qaResult = await executeAgent(
            qaRole.systemPrompt,
            `## Task Being Reviewed\n**Title:** ${task.title}\n**Description:** ${task.description}\n\n## Agent Output to Review\n${result.output}`,
            qaRole.model,
          );

          let review: { score: number; verdict: string; summary: string };
          try {
            review = JSON.parse(qaResult.output);
          } catch {
            review = { score: 3, verdict: 'needs_revision', summary: 'Could not parse QA output' };
          }

          // QA creates a DM with the review
          if (qaAgentId) {
            await createDM(handoff.channelId, qaAgentId, 'Agentcy: QA Editor', handoff.fromAgentId, handoff.fromAgentName,
              `QA Review for "${task.title}": ${review.verdict} (${review.score}/5) — ${review.summary}`, {
                type: 'status_update',
                handoffId,
                review: qaResult.output,
              });
          }

          // Complete the handoff with the QA score as rating
          const rating = Math.min(5, Math.max(1, review.score));
          await completeHandoff(handoffId, handoff, rating, review.summary, result, qaResult);

          send('qa_done', {
            score: review.score,
            verdict: review.verdict,
            summary: review.summary,
            qaCost: qaResult.costUsd,
          });
        } else {
          // Complete without QA
          await completeHandoff(handoffId, handoff, null, null, result, null);
        }

        // Memory flush: extract key facts and write to persistent memory
        send('status', { message: 'Saving to memory...' });
        try {
          const extracted = await extractMemories(task.title, task.description, result.output, role.slug);
          if (extracted.length > 0) {
            const memWrites: MemoryWrite[] = extracted.map(m => ({
              agentId: handoff.toAgentId,
              agentSlug: role.slug,
              type: m.type,
              content: m.content,
              tags: m.tags,
              source: handoffId,
              importance: m.importance,
              expiresAt: m.expiresInDays ? new Date(Date.now() + m.expiresInDays * 86400000) : undefined,
            }));
            await writeMemories(memWrites);
            send('memory_saved', { count: extracted.length, memories: extracted.map(m => m.content) });
          }

          // Append to daily notes
          await appendDailyNote(role.slug, `Completed: ${task.title}`, handoffId, 'work');
          await appendDailyNote('system', `${role.name} completed handoff: ${task.title}`, handoffId, 'handoff');
        } catch {
          // Memory extraction is non-critical
        }

        send('complete', { handoffId });
        controller.close();

      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        send('error', { error: message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Helper: create a DM in a channel
async function createDM(
  channelId: string,
  fromAgentId: string,
  fromAgentName: string,
  toAgentId: string,
  toAgentName: string,
  message: string,
  payload?: Record<string, unknown>,
) {
  await db.directMessage.create({
    data: {
      channelId,
      fromAgentId,
      fromAgentName,
      toAgentId,
      toAgentName,
      message,
      payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
    },
  });
  await db.dMChannel.update({
    where: { id: channelId },
    data: { lastMessageAt: new Date() },
  });
}

// Helper: complete a handoff (requester = Chief of Staff auto-completes)
async function completeHandoff(
  handoffId: string,
  handoff: { fromAgentId: string; fromAgentName: string; toAgentId: string; toAgentName: string; channelId: string; task: unknown },
  rating: number | null,
  reviewText: string | null,
  result: ExecutionResult,
  qaResult: ExecutionResult | null,
) {
  const task = handoff.task as { title: string };

  await db.handoff.update({
    where: { id: handoffId },
    data: {
      status: 'completed',
      rating,
      review: reviewText,
      completedAt: new Date(),
    },
  });

  // Add peer review if rated
  if (rating) {
    const worker = await db.agent.findUnique({ where: { id: handoff.toAgentId } });
    if (worker) {
      const reviews = Array.isArray(worker.peerReviews) ? worker.peerReviews as Array<Record<string, unknown>> : [];
      reviews.unshift({
        agentId: handoff.fromAgentId,
        agentName: handoff.fromAgentName,
        rating,
        comment: reviewText || `Completed: ${task.title}`,
        handoffId,
        date: new Date().toISOString(),
        metadata: {
          costUsd: result.costUsd + (qaResult?.costUsd || 0),
          latencyMs: result.latencyMs + (qaResult?.latencyMs || 0),
          toolCalls: result.toolCalls?.length || 0,
        },
      });
      await db.agent.update({
        where: { id: handoff.toAgentId },
        data: { peerReviews: reviews as unknown as import('@prisma/client').Prisma.InputJsonValue },
      });
    }
  }

  // Update worker stats
  await updateWorkerStats(handoff.toAgentId);

  // Completion DM
  await createDM(handoff.channelId, handoff.fromAgentId, handoff.fromAgentName, handoff.toAgentId, handoff.toAgentName,
    `Handoff completed${rating ? ` (${rating}/5)` : ''}: ${task.title}`,
    { type: 'status_update', handoffId, status: 'completed' });
}

async function updateWorkerStats(agentId: string) {
  const completed = await db.handoff.count({ where: { toAgentId: agentId, status: 'completed' } });
  const rejected = await db.handoff.count({ where: { toAgentId: agentId, status: 'rejected' } });
  const total = completed + rejected;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 100;

  const ratings = await db.handoff.findMany({
    where: { toAgentId: agentId, status: 'completed', rating: { not: null } },
    select: { rating: true },
  });
  const avgRating = ratings.length > 0
    ? ratings.reduce((sum, h) => sum + (h.rating || 0), 0) / ratings.length
    : 5;

  const volumeScore = Math.min(completed * 10, 50);
  const qualityScore = Math.round(avgRating * 10);
  const reliabilityBonus = successRate >= 90 ? 10 : successRate >= 75 ? 5 : 0;
  const reputationScore = Math.min(volumeScore + qualityScore + reliabilityBonus, 100);

  await db.agent.update({
    where: { id: agentId },
    data: {
      tasksCompleted: completed,
      successRate,
      reputationScore,
      trustTier: reputationScore >= 90 ? 'enterprise' : reputationScore >= 70 ? 'trusted' : 'verified',
      lastSeen: new Date(),
    },
  });
}
