import { NextResponse } from 'next/server';
import { setupAgentcyTeam, getAgentcyAgents } from '@/lib/agentcy-setup';

// POST /api/agentcy/setup — Register all agentcy agents in the AgentNet directory
export async function POST() {
  try {
    const registered = await setupAgentcyTeam();
    return NextResponse.json({
      message: `Registered ${registered.length} agentcy agents in the directory`,
      agents: registered,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Setup failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET /api/agentcy/setup — Check if agents are registered
export async function GET() {
  try {
    const agents = await getAgentcyAgents();
    return NextResponse.json({
      registered: agents.length > 0,
      count: agents.length,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        trustTier: a.trustTier,
        reputationScore: a.reputationScore,
        hasApiKey: a.apiKeys.length > 0,
      })),
    });
  } catch {
    return NextResponse.json({ registered: false, count: 0, agents: [] });
  }
}
