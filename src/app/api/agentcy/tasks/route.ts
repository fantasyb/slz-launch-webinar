import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/agentcy/tasks — List tasks (filterable)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sprintId = searchParams.get('sprintId');
  const status = searchParams.get('status');
  const assignedTo = searchParams.get('assignedTo');

  try {
    const where: Record<string, unknown> = {};
    if (sprintId) where.sprintId = sprintId;
    if (status) where.status = status;
    if (assignedTo) where.assignedTo = assignedTo;

    const tasks = await db.task.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(tasks);
  } catch {
    return NextResponse.json([]);
  }
}

// PATCH /api/agentcy/tasks — Update a task
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { taskId, ...updates } = body;

    if (!taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }

    // Only allow safe updates
    const allowed: Record<string, unknown> = {};
    if (updates.status) allowed.status = updates.status;
    if (updates.priority) allowed.priority = updates.priority;
    if (updates.assignedTo) allowed.assignedTo = updates.assignedTo;
    if (updates.input) allowed.input = updates.input;
    if (updates.title) allowed.title = updates.title;
    if (updates.description) allowed.description = updates.description;

    const task = await db.task.update({
      where: { id: taskId },
      data: allowed,
    });

    return NextResponse.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
