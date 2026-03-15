import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { runTask, reviewOutput } from '@/lib/agentcy';

// POST /api/agentcy/run — Execute a task (run the assigned agent, then QA)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId, skipQA } = body as { taskId: string; skipQA?: boolean };

    if (!taskId) {
      return new Response(JSON.stringify({ error: 'taskId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!task.assignedTo) {
      return new Response(JSON.stringify({ error: 'Task has no assigned agent' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream the execution
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          // Mark task as in_progress
          await db.task.update({
            where: { id: taskId },
            data: { status: 'in_progress', startedAt: new Date() },
          });

          send('status', { message: `${task.assignedTo} is working on: ${task.title}...` });

          // Run the agent
          const result = await runTask(
            task.assignedTo!,
            task.title,
            task.description,
            task.input || undefined,
          );

          // Save the output
          await db.task.update({
            where: { id: taskId },
            data: {
              output: result.output,
              tokenCount: result.inputTokens + result.outputTokens,
              costUsd: result.costUsd,
              latencyMs: result.latencyMs,
              status: skipQA ? 'approved' : 'in_review',
              completedAt: skipQA ? new Date() : undefined,
            },
          });

          send('agent_done', {
            output: result.output,
            tokens: result.inputTokens + result.outputTokens,
            cost: result.costUsd,
            latency: result.latencyMs,
          });

          // QA Review (unless skipped)
          if (!skipQA) {
            send('status', { message: 'QA Editor is reviewing...' });

            const { review, execution: qaExecution } = await reviewOutput(
              task.title,
              task.description,
              result.output,
            );

            const newStatus = review.verdict === 'approved' ? 'approved' :
                              review.verdict === 'rejected' ? 'rejected' : 'revision';

            await db.task.update({
              where: { id: taskId },
              data: {
                qaFeedback: JSON.stringify(review),
                qaScore: review.score,
                status: newStatus,
                costUsd: result.costUsd + qaExecution.costUsd,
                tokenCount: (result.inputTokens + result.outputTokens) + (qaExecution.inputTokens + qaExecution.outputTokens),
                completedAt: newStatus === 'approved' ? new Date() : undefined,
                // If QA provided a revised version and approved, use it
                output: review.revisedOutput && review.verdict === 'approved'
                  ? review.revisedOutput
                  : result.output,
              },
            });

            send('qa_done', {
              score: review.score,
              verdict: review.verdict,
              summary: review.summary,
              strengths: review.strengths,
              issues: review.issues,
              suggestions: review.suggestions,
              qaCost: qaExecution.costUsd,
            });
          }

          // Fetch final task state
          const finalTask = await db.task.findUnique({ where: { id: taskId } });
          send('complete', { task: finalTask });
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          send('error', { error: message });

          // Mark task as failed
          await db.task.update({
            where: { id: taskId },
            data: { status: 'rejected' },
          }).catch(() => {});

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
