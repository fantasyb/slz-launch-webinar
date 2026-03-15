import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { parseBreif, AGENT_ROLES } from '@/lib/agentcy';
import { getAgentIdMap, setupAgentcyTeam } from '@/lib/agentcy-setup';

// POST /api/agentcy/brief — Submit a brief → Chief of Staff breaks it down → creates handoffs
export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const body = await request.json();
        const { brief } = body as { brief: string };

        if (!brief || brief.trim().length === 0) {
          send('error', { error: 'Brief is required' });
          controller.close();
          return;
        }

        // Ensure agentcy agents are registered
        let agentIdMap = await getAgentIdMap();
        if (Object.keys(agentIdMap).length === 0) {
          send('status', { message: 'Setting up your team in the directory...' });
          await setupAgentcyTeam();
          agentIdMap = await getAgentIdMap();
        }

        const chiefId = agentIdMap['chief-of-staff'];
        if (!chiefId) {
          send('error', { error: 'Chief of Staff not found in directory. Run setup first.' });
          controller.close();
          return;
        }

        send('status', { message: 'Chief of Staff is analyzing your brief...' });

        // 1. Chief of Staff parses the brief into tasks
        const { tasks, execution } = await parseBreif(brief);

        send('chief_done', {
          taskCount: tasks.length,
          cost: execution.costUsd,
          latency: execution.latencyMs,
        });

        // 2. For each task, create a DM channel + handoff to the assigned agent
        const handoffIds: string[] = [];
        for (const task of tasks) {
          const workerAgentId = agentIdMap[task.assignedTo];
          if (!workerAgentId) {
            send('status', { message: `Skipping task "${task.title}" — no agent found for role: ${task.assignedTo}` });
            continue;
          }

          const workerRole = AGENT_ROLES.find(r => r.slug === task.assignedTo);
          const workerName = `Agentcy: ${workerRole?.name || task.assignedTo}`;
          const chiefName = 'Agentcy: Chief of Staff';

          // Find or create DM channel between Chief and worker
          let channel = await db.dMChannel.findFirst({
            where: {
              OR: [
                { agent1Id: chiefId, agent2Id: workerAgentId },
                { agent1Id: workerAgentId, agent2Id: chiefId },
              ],
            },
          });

          if (!channel) {
            channel = await db.dMChannel.create({
              data: {
                agent1Id: chiefId,
                agent1Name: chiefName,
                agent2Id: workerAgentId,
                agent2Name: workerName,
              },
            });
          }

          // Create the handoff
          const handoff = await db.handoff.create({
            data: {
              fromAgentId: chiefId,
              fromAgentName: chiefName,
              toAgentId: workerAgentId,
              toAgentName: workerName,
              channelId: channel.id,
              status: 'proposed',
              task: {
                title: task.title,
                description: task.description,
                priority: task.priority,
              },
              securityTier: 'standard',
              requiredTrust: 'unverified',
              auditLog: [{ action: 'proposed', agentId: chiefId, timestamp: new Date().toISOString(), source: 'brief' }],
            },
          });

          // Chief sends a DM about the handoff
          await db.directMessage.create({
            data: {
              channelId: channel.id,
              fromAgentId: chiefId,
              fromAgentName: chiefName,
              toAgentId: workerAgentId,
              toAgentName: workerName,
              message: `New task from brief: ${task.title}\n\n${task.description}`,
              payload: {
                type: 'task_proposal',
                handoffId: handoff.id,
                task: { title: task.title, description: task.description },
                priority: task.priority,
              },
            },
          });

          await db.dMChannel.update({
            where: { id: channel.id },
            data: { lastMessageAt: new Date() },
          });

          handoffIds.push(handoff.id);

          send('handoff_created', {
            handoffId: handoff.id,
            title: task.title,
            assignedTo: task.assignedTo,
            priority: task.priority,
            workerName,
          });
        }

        send('complete', {
          handoffCount: handoffIds.length,
          handoffIds,
          briefCost: execution.costUsd,
        });

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
