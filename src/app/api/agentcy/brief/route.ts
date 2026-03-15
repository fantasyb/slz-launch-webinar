import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { parseBreif } from '@/lib/agentcy';

// POST /api/agentcy/brief — Submit a brief, Chief of Staff breaks it into tasks
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { brief, sprintName } = body as { brief: string; sprintName?: string };

    if (!brief || brief.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Brief is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream the response with SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          send('status', { message: 'Chief of Staff is analyzing your brief...' });

          // 1. Have Chief of Staff parse the brief into tasks
          const { tasks, execution } = await parseBreif(brief);

          send('chief_done', {
            taskCount: tasks.length,
            cost: execution.costUsd,
            latency: execution.latencyMs,
          });

          // 2. Create the sprint
          const name = sprintName || `Brief — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
          const sprint = await db.sprint.create({
            data: {
              name,
              brief,
              status: 'active',
            },
          });

          // 3. Create tasks in the database
          const createdTasks = [];
          for (const task of tasks) {
            const created = await db.task.create({
              data: {
                sprintId: sprint.id,
                title: task.title,
                description: task.description,
                status: 'pending',
                priority: task.priority,
                assignedTo: task.assignedTo,
                createdBy: 'chief-of-staff',
              },
            });
            createdTasks.push(created);
            send('task_created', {
              id: created.id,
              title: created.title,
              assignedTo: created.assignedTo,
              priority: created.priority,
            });
          }

          send('complete', {
            sprintId: sprint.id,
            sprintName: sprint.name,
            taskCount: createdTasks.length,
            tasks: createdTasks,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
