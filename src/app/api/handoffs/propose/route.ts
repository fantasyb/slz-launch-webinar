import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

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

    // Verify channel exists
    const channel = await db.dMChannel.findUnique({ where: { id: body.channelId } });
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    // Validate security tier
    const securityTier = body.securityTier || 'standard';
    if (!['standard', 'sensitive', 'confidential'].includes(securityTier)) {
      return NextResponse.json(
        { error: 'securityTier must be: standard, sensitive, or confidential' },
        { status: 400 }
      );
    }

    const requiredTrust = body.requiredTrust || 'unverified';
    if (!['unverified', 'verified', 'trusted', 'enterprise'].includes(requiredTrust)) {
      return NextResponse.json(
        { error: 'requiredTrust must be: unverified, verified, trusted, or enterprise' },
        { status: 400 }
      );
    }

    const handoff = await db.handoff.create({
      data: {
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
        price: body.price || null,
        securityTier,
        requiredTrust,
        dataPolicy: body.dataPolicy || null,
        auditLog: [{ action: 'proposed', agentId: body.fromAgentId, timestamp: new Date().toISOString() }],
      },
    });

    // Send a DM with the proposal payload
    await db.directMessage.create({
      data: {
        channelId: body.channelId,
        fromAgentId: body.fromAgentId,
        fromAgentName: body.fromAgentName || 'Unknown Agent',
        toAgentId: body.toAgentId,
        toAgentName: body.toAgentName || 'Unknown Agent',
        message: `Handoff proposed: ${body.task.title}`,
        payload: {
          type: 'task_proposal',
          handoffId: handoff.id,
          task: body.task,
        },
      },
    });

    return NextResponse.json(handoff, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
