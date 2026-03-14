import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth, isAuthResponse } from '@/lib/auth';
import { validateBody, verifyAgentSchema } from '@/lib/validators';
import { logAudit, getClientIp } from '@/lib/audit';
import type { TrustTier } from '@/data/seed';

const TRUST_TIERS: { tier: TrustTier; minReputation: number; requiresVerification: boolean }[] = [
  { tier: 'enterprise', minReputation: 90, requiresVerification: true },
  { tier: 'trusted', minReputation: 70, requiresVerification: true },
  { tier: 'verified', minReputation: 0, requiresVerification: true },
  { tier: 'unverified', minReputation: 0, requiresVerification: false },
];

function calculateTrustTier(verified: boolean, reputation: number): TrustTier {
  for (const t of TRUST_TIERS) {
    if (verified >= t.requiresVerification && reputation >= t.minReputation) {
      return t.tier;
    }
  }
  return 'unverified';
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth(request);
    if (isAuthResponse(auth)) return auth;

    const body = await request.json();
    const validated = validateBody(verifyAgentSchema, body);
    if ('error' in validated) return validated.error;
    const { agentId, method, proof } = validated.data;

    // Ensure authenticated agent matches the agent being verified
    if (auth.agentId !== agentId) {
      return NextResponse.json({ error: 'You can only verify your own agent' }, { status: 403 });
    }

    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    let verified = false;
    let verificationDetail = '';

    if (method === 'domain') {
      try {
        const endpointDomain = new URL(agent.endpoint).hostname;
        const proofDomain = proof.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

        if (endpointDomain === proofDomain || endpointDomain.endsWith('.' + proofDomain)) {
          verified = true;
          verificationDetail = `Domain verified: ${proofDomain}`;
        } else {
          return NextResponse.json({
            error: `Domain mismatch. Agent endpoint is on ${endpointDomain}, but proof domain is ${proofDomain}`,
            hint: `Add a DNS TXT record "agentnet-verify=${agentId}" to ${endpointDomain}`,
          }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'Invalid domain in proof' }, { status: 400 });
      }
    }

    if (method === 'twitter') {
      if (typeof proof === 'string' && proof.includes(agentId)) {
        verified = true;
        verificationDetail = `Twitter verified via proof containing agent ID`;
      } else {
        return NextResponse.json({
          error: 'Twitter proof must contain the agent ID',
          hint: `Tweet: "Verifying on AgentNet: ${agentId}" and provide the tweet URL as proof`,
        }, { status: 400 });
      }
    }

    if (!verified) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 });
    }

    const trustTier = calculateTrustTier(true, agent.reputationScore);

    const updated = await db.agent.update({
      where: { id: agentId },
      data: {
        ownerVerified: true,
        verificationMethod: method,
        verificationProof: proof,
        trustTier,
      },
    });

    logAudit({
      agentId,
      action: 'agent.verify',
      resource: 'agent',
      resourceId: agentId,
      metadata: { method, trustTier },
      ip: getClientIp(request),
    });

    return NextResponse.json({
      verified: true,
      method,
      detail: verificationDetail,
      trustTier,
      agent: {
        id: updated.id,
        name: updated.name,
        ownerVerified: updated.ownerVerified,
        verificationMethod: updated.verificationMethod,
        trustTier: updated.trustTier,
        reputationScore: updated.reputationScore,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get('agentId');

  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }

  const agent = await db.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  const endpointDomain = (() => {
    try { return new URL(agent.endpoint).hostname; } catch { return null; }
  })();

  return NextResponse.json({
    agentId: agent.id,
    name: agent.name,
    verified: agent.ownerVerified,
    verificationMethod: agent.verificationMethod,
    trustTier: agent.trustTier,
    reputationScore: agent.reputationScore,
    howToVerify: agent.ownerVerified ? null : {
      domain: {
        step1: `Add a DNS TXT record to ${endpointDomain || 'your domain'}: agentnet-verify=${agentId}`,
        step2: `POST /api/agents/verify with { agentId: "${agentId}", method: "domain", proof: "${endpointDomain || 'yourdomain.com'}" }`,
      },
      twitter: {
        step1: `Tweet: "Verifying on AgentNet: ${agentId}"`,
        step2: `POST /api/agents/verify with { agentId: "${agentId}", method: "twitter", proof: "https://twitter.com/you/status/..." }`,
      },
    },
    trustTiers: {
      unverified: 'No verification. Can only do standard-tier handoffs.',
      verified: 'Identity confirmed. Can handle sensitive data.',
      trusted: 'Verified + 70+ reputation. Can handle confidential data.',
      enterprise: 'Verified + 90+ reputation. Full access. SOC2/HIPAA eligible.',
    },
  });
}
