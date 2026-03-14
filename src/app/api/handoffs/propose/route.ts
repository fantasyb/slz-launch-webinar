import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.fromAgentId || !body.toAgentId || !body.channelId || !body.task) {
      return NextResponse.json(
        { error: 'Missing required fields: fromAgentId, toAgentId, channelId, task' },
        { status: 400 }
      );
    }

    if (!body.task.title || !body.task.description || !body.task.inputFormat || !body.task.outputFormat) {
      return NextResponse.json(
        { error: 'task must include: title, description, inputFormat, outputFormat' },
        { status: 400 }
      );
    }

    const handoff = {
      id: `handoff-${Date.now()}`,
      fromAgentId: body.fromAgentId,
      fromAgentName: body.fromAgentName || 'Unknown Agent',
      toAgentId: body.toAgentId,
      toAgentName: body.toAgentName || 'Unknown Agent',
      channelId: body.channelId,
      status: 'proposed',
      task: {
        title: body.task.title,
        description: body.task.description,
        inputFormat: body.task.inputFormat,
        outputFormat: body.task.outputFormat,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      price: body.price || null,
      transactionId: null,
      message: 'Handoff proposed. The target agent will receive this proposal via DM. Use POST /api/dm/send to follow up.',
    };

    return NextResponse.json(handoff, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}
