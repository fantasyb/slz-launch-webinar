import { PrismaClient } from '@prisma/client';
import {
  seedAgents,
  seedListings,
  seedChannels,
  seedMessages,
  seedHandoffs,
} from '../src/data/seed';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Clear existing data in reverse dependency order
  await prisma.directMessage.deleteMany();
  await prisma.handoff.deleteMany();
  await prisma.dMChannel.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.agent.deleteMany();

  console.log('Cleared existing data.');

  // Seed agents
  for (const a of seedAgents) {
    await prisma.agent.create({
      data: {
        id: a.id,
        name: a.name,
        avatarColor: a.avatarColor,
        owner: a.owner,
        ownerVerified: a.ownerVerified,
        verificationMethod: a.verificationMethod,
        entity: a.entity,
        bio: a.bio,
        skills: a.skills as unknown as object[],
        categories: a.categories,
        rateLimits: a.rateLimits,
        availability: a.availability,
        tasksCompleted: a.tasksCompleted,
        successRate: a.successRate,
        avgResponseTime: a.avgResponseTime,
        uptime30d: a.uptime30d,
        joinDate: new Date(a.joinDate),
        peerReviews: a.peerReviews as unknown as object[],
        endpoint: a.endpoint,
        protocols: a.protocols,
        authMethod: a.authMethod,
        payloadFormat: a.payloadFormat,
        status: a.status,
        lastSeen: new Date(a.lastSeen),
        price: a.price,
        walletAddress: a.walletAddress,
        reputationScore: a.reputationScore,
        trustTier: a.trustTier,
        securityPolicy: a.securityPolicy ? (a.securityPolicy as unknown as object) : undefined,
      },
    });
  }
  console.log(`Seeded ${seedAgents.length} agents.`);

  // Seed listings (non-threaded first, then threaded)
  const rootListings = seedListings.filter(l => !l.parentId);
  const threadedListings = seedListings.filter(l => l.parentId);

  for (const l of rootListings) {
    await prisma.listing.create({
      data: {
        id: l.id,
        agentId: l.agentId,
        agentName: l.agentName,
        section: l.section,
        title: l.title,
        description: l.description,
        endpoint: l.endpoint,
        categories: l.categories,
        price: l.price,
        transactionId: l.transactionId,
        parentId: null,
        parentTitle: null,
        createdAt: new Date(l.createdAt),
      },
    });
  }
  for (const l of threadedListings) {
    await prisma.listing.create({
      data: {
        id: l.id,
        agentId: l.agentId,
        agentName: l.agentName,
        section: l.section,
        title: l.title,
        description: l.description,
        endpoint: l.endpoint,
        categories: l.categories,
        price: l.price,
        transactionId: l.transactionId,
        parentId: l.parentId,
        parentTitle: l.parentTitle,
        createdAt: new Date(l.createdAt),
      },
    });
  }
  console.log(`Seeded ${seedListings.length} listings.`);

  // Seed DM channels
  for (const c of seedChannels) {
    await prisma.dMChannel.create({
      data: {
        id: c.id,
        agent1Id: c.agentIds[0],
        agent1Name: c.agentNames[0],
        agent2Id: c.agentIds[1],
        agent2Name: c.agentNames[1],
        createdAt: new Date(c.createdAt),
        lastMessageAt: new Date(c.lastMessageAt),
      },
    });
  }
  console.log(`Seeded ${seedChannels.length} DM channels.`);

  // Seed direct messages
  for (const m of seedMessages) {
    await prisma.directMessage.create({
      data: {
        id: m.id,
        channelId: m.channelId,
        fromAgentId: m.fromAgentId,
        fromAgentName: m.fromAgentName,
        toAgentId: m.toAgentId,
        toAgentName: m.toAgentName,
        message: m.message,
        payload: m.payload ? (m.payload as unknown as object) : undefined,
        timestamp: new Date(m.timestamp),
      },
    });
  }
  console.log(`Seeded ${seedMessages.length} direct messages.`);

  // Seed handoffs
  for (const h of seedHandoffs) {
    await prisma.handoff.create({
      data: {
        id: h.id,
        fromAgentId: h.fromAgentId,
        fromAgentName: h.fromAgentName,
        toAgentId: h.toAgentId,
        toAgentName: h.toAgentName,
        channelId: h.channelId,
        status: h.status,
        task: h.task as unknown as object,
        price: h.price,
        transactionId: h.transactionId,
        securityTier: h.securityTier,
        requiredTrust: h.requiredTrust,
        dataPolicy: h.dataPolicy ? (h.dataPolicy as unknown as object) : undefined,
        createdAt: new Date(h.createdAt),
        updatedAt: new Date(h.updatedAt),
      },
    });
  }
  console.log(`Seeded ${seedHandoffs.length} handoffs.`);

  console.log('Done!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
