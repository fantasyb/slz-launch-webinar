// Agentcy Setup — Registers agentcy agents in the AgentNet directory
// Each agent gets a real Agent record, API key, and can participate in handoffs/DMs

import { db } from './db';
import { generateApiKey } from './auth';
import { AGENT_ROLES } from './agentcy';

const AGENTCY_OWNER = 'agentcy-internal';

export interface RegisteredAgent {
  id: string;
  name: string;
  slug: string;
  apiKey: string;
}

// Check if agentcy agents are already registered
export async function getAgentcyAgents() {
  const agents = await db.agent.findMany({
    where: { owner: AGENTCY_OWNER },
    include: {
      apiKeys: {
        where: { revokedAt: null },
        select: { id: true, keyPrefix: true },
        take: 1,
      },
    },
    orderBy: { joinDate: 'asc' },
  });
  return agents;
}

// Register all agentcy agents in the Agent table
// Returns the agent records with their API keys (keys only shown once)
export async function setupAgentcyTeam(): Promise<RegisteredAgent[]> {
  const registered: RegisteredAgent[] = [];

  for (const role of AGENT_ROLES) {
    // Check if already registered
    const existing = await db.agent.findUnique({
      where: { name: `Agentcy: ${role.name}` },
    });

    if (existing) {
      // Ensure they have an active API key
      const existingKey = await db.apiKey.findFirst({
        where: { agentId: existing.id, revokedAt: null },
      });
      registered.push({
        id: existing.id,
        name: role.name,
        slug: role.slug,
        apiKey: existingKey ? `(already registered — key prefix: ${existingKey.keyPrefix}...)` : '(no active key)',
      });
      continue;
    }

    // Register new agent
    const agent = await db.agent.create({
      data: {
        name: `Agentcy: ${role.name}`,
        avatarColor: role.avatarColor,
        owner: AGENTCY_OWNER,
        ownerVerified: true,
        verificationMethod: 'internal',
        entity: 'Agentcy Internal Team',
        bio: role.description,
        skills: JSON.parse(JSON.stringify(getSkillsForRole(role.slug))),
        categories: JSON.parse(JSON.stringify(getCategoriesForRole(role.slug))),
        endpoint: `/api/agentcy/process`,
        protocols: JSON.parse(JSON.stringify(['REST'])),
        authMethod: 'Bearer Token',
        status: 'online',
        trustTier: 'trusted',
        reputationScore: 75,
      },
    });

    // Generate API key
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.apiKey.create({
      data: {
        agentId: agent.id,
        keyHash,
        keyPrefix,
        name: `${role.slug}-default`,
      },
    });

    // Link to AgentRole if it exists
    await db.agentRole.updateMany({
      where: { slug: role.slug },
      data: { agentId: agent.id },
    });

    registered.push({
      id: agent.id,
      name: role.name,
      slug: role.slug,
      apiKey: key,
    });
  }

  return registered;
}

// Get the Agent ID for a given role slug
export async function getAgentIdForRole(slug: string): Promise<string | null> {
  const roleDef = AGENT_ROLES.find(r => r.slug === slug);
  if (!roleDef) return null;

  const agent = await db.agent.findUnique({
    where: { name: `Agentcy: ${roleDef.name}` },
    select: { id: true },
  });
  return agent?.id || null;
}

// Get all agent IDs mapped by slug
export async function getAgentIdMap(): Promise<Record<string, string>> {
  const agents = await db.agent.findMany({
    where: { owner: AGENTCY_OWNER },
    select: { id: true, name: true },
  });

  const map: Record<string, string> = {};
  for (const agent of agents) {
    // Extract role name from "Agentcy: Role Name"
    const roleName = agent.name.replace('Agentcy: ', '');
    const role = AGENT_ROLES.find(r => r.name === roleName);
    if (role) {
      map[role.slug] = agent.id;
    }
  }
  return map;
}

// Get the API key for an agent (for internal use — NOT the raw key, but the hash lookup)
export async function getAgentApiKey(agentId: string): Promise<string | null> {
  const apiKey = await db.apiKey.findFirst({
    where: { agentId, revokedAt: null },
    select: { keyHash: true },
  });
  return apiKey?.keyHash || null;
}

function getSkillsForRole(slug: string) {
  switch (slug) {
    case 'chief-of-staff':
      return [
        { name: 'Task Decomposition', inputFormat: 'brief text', outputFormat: 'JSON task array' },
        { name: 'Sprint Planning', inputFormat: 'goals', outputFormat: 'structured plan' },
      ];
    case 'researcher':
      return [
        { name: 'Market Research', inputFormat: 'topic/query', outputFormat: 'structured report' },
        { name: 'Competitor Analysis', inputFormat: 'company name', outputFormat: 'analysis report' },
      ];
    case 'content-writer':
      return [
        { name: 'Social Media Copy', inputFormat: 'topic + platform', outputFormat: 'post copy' },
        { name: 'Newsletter Writing', inputFormat: 'topic + audience', outputFormat: 'newsletter draft' },
      ];
    case 'demo-engineer':
      return [
        { name: 'Demo Script', inputFormat: 'product + audience', outputFormat: 'demo playbook' },
        { name: 'Documentation', inputFormat: 'feature description', outputFormat: 'docs' },
      ];
    case 'qa-editor':
      return [
        { name: 'Content Review', inputFormat: 'draft content', outputFormat: 'JSON review' },
        { name: 'Quality Scoring', inputFormat: 'deliverable', outputFormat: 'score + feedback' },
      ];
    case 'cfo':
      return [
        { name: 'Financial Snapshot', inputFormat: 'date range', outputFormat: 'financial report' },
        { name: 'Revenue Analysis', inputFormat: 'query', outputFormat: 'analysis with data' },
      ];
    case 'support-lead':
      return [
        { name: 'Ticket Triage', inputFormat: 'ticket data', outputFormat: 'classification + draft' },
        { name: 'KB Search', inputFormat: 'query', outputFormat: 'relevant articles' },
      ];
    case 'client-care':
      return [
        { name: 'Client Health Check', inputFormat: 'client ID or all', outputFormat: 'health report' },
        { name: 'Engagement Tracking', inputFormat: 'client interactions', outputFormat: 'log entries' },
      ];
    default:
      return [];
  }
}

function getCategoriesForRole(slug: string) {
  switch (slug) {
    case 'chief-of-staff': return ['management', 'coordination', 'planning'];
    case 'researcher': return ['research', 'analysis', 'intelligence'];
    case 'content-writer': return ['writing', 'marketing', 'content'];
    case 'demo-engineer': return ['technical', 'demos', 'documentation'];
    case 'qa-editor': return ['quality', 'review', 'editing'];
    case 'cfo': return ['finance', 'accounting', 'billing'];
    case 'support-lead': return ['support', 'customer-service', 'triage'];
    case 'client-care': return ['crm', 'client-management', 'relationships'];
    default: return [];
  }
}
