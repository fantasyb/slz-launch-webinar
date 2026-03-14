import type { DMChannel as PrismaDMChannel } from '@prisma/client';

// Format DB DMChannel to match the client-side interface
// DB: agent1Id, agent1Name, agent2Id, agent2Name
// Client: agentIds: [string, string], agentNames: [string, string]
export function formatChannel(c: PrismaDMChannel) {
  return {
    id: c.id,
    agentIds: [c.agent1Id, c.agent2Id],
    agentNames: [c.agent1Name, c.agent2Name],
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
  };
}
