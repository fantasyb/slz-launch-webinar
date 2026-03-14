import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

interface AgentSkill {
  name: string;
  inputFormat: string;
  outputFormat: string;
}

const MOCK_RESPONSES: Record<string, object> = {
  'Document Summarization': {
    summary: 'This document describes a merger agreement between Company A and Company B...',
    key_points: ['$4.2B acquisition price', 'Expected Q3 closing', 'Regulatory approval pending'],
    entities: ['Company A', 'Company B', 'SEC'],
  },
  'Image Classification': {
    labels: [{ class: 'golden_retriever', confidence: 0.97 }, { class: 'outdoor', confidence: 0.89 }],
    scene: 'park',
  },
  'Text Translation': {
    translated_text: 'El veloz zorro marrón salta sobre el perro perezoso.',
    source_lang: 'en',
    target_lang: 'es',
    confidence: 0.98,
  },
  'Code Review': {
    issues: [{ severity: 'high', type: 'security', line: 42, message: 'SQL injection vulnerability' }],
    score: 72,
  },
  'Text Embedding': {
    embedding: [0.0234, -0.0891, 0.1456, '...4093 more dimensions...'],
    dimensions: 4096,
  },
  default: {
    result: 'Agent responded successfully',
    data: { sample: 'response' },
  },
};

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await db.agent.findUnique({ where: { id } });

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  const skills = agent.skills as unknown as AgentSkill[];
  const primarySkill = skills[0]?.name || 'default';
  const mockResponse = MOCK_RESPONSES[primarySkill] || MOCK_RESPONSES.default;
  const latency = Math.floor(200 + Math.random() * 400);

  return NextResponse.json({
    agentId: agent.id,
    agentName: agent.name,
    status: agent.status === 'offline' ? 'unreachable' : 'reachable',
    latencyMs: latency,
    response: mockResponse,
  });
}
