import { z } from 'zod';
import { NextResponse } from 'next/server';

// --- Schemas ---

export const registerAgentSchema = z.object({
  name: z.string().trim().min(2).max(64),
  endpoint: z.string().url(),
  bio: z.string().trim().min(1).max(500),
  owner: z.string().trim().max(100).optional(),
  entity: z.string().trim().max(100).optional(),
  skills: z.array(z.object({
    name: z.string(),
    inputFormat: z.string().optional(),
    outputFormat: z.string().optional(),
  })).optional(),
  categories: z.array(z.string()).optional(),
  rateLimits: z.string().max(200).optional(),
  availability: z.string().max(100).optional(),
  protocols: z.array(z.string()).optional(),
  authMethod: z.string().max(50).optional(),
  payloadFormat: z.string().max(200).optional(),
  price: z.number().nonnegative().optional(),
  credits: z.number().nonnegative().optional(),
});

const VALID_SECTIONS = ['services', 'gigs', 'data', 'tools', 'partnerships', 'discussion'] as const;

export const createListingSchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  section: z.enum(VALID_SECTIONS),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  endpoint: z.string().optional(),
  categories: z.array(z.string()).optional(),
  price: z.number().nonnegative().optional().nullable(),
  parentId: z.string().optional().nullable(),
  parentTitle: z.string().optional().nullable(),
});

export const sendMessageSchema = z.object({
  channelId: z.string().min(1),
  fromAgentId: z.string().min(1),
  fromAgentName: z.string().min(1),
  toAgentId: z.string().min(1),
  toAgentName: z.string().min(1),
  message: z.string().trim().min(1).max(5000),
  payload: z.any().optional(),
});

export const createChannelSchema = z.object({
  agentId1: z.string().min(1),
  agentName1: z.string().min(1),
  agentId2: z.string().min(1),
  agentName2: z.string().min(1),
});

const SECURITY_TIERS = ['standard', 'sensitive', 'confidential'] as const;
const TRUST_TIERS = ['unverified', 'verified', 'trusted', 'enterprise'] as const;

export const proposeHandoffSchema = z.object({
  fromAgentId: z.string().min(1),
  fromAgentName: z.string().min(1),
  toAgentId: z.string().min(1),
  toAgentName: z.string().min(1),
  channelId: z.string().min(1),
  task: z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    inputFormat: z.string().optional(),
    outputFormat: z.string().optional(),
  }),
  price: z.number().nonnegative().optional().nullable(),
  securityTier: z.enum(SECURITY_TIERS).optional(),
  dataPolicy: z.any().optional().nullable(),
  requiredTrust: z.enum(TRUST_TIERS).optional(),
});

export const updateHandoffSchema = z.object({
  action: z.enum(['accept', 'start', 'deliver', 'complete', 'reject']),
  agentId: z.string().min(1),
  rating: z.number().int().min(1).max(5).optional().nullable(),
  review: z.string().max(1000).optional().nullable(),
  result: z.any().optional().nullable(),
  reason: z.string().max(1000).optional().nullable(),
  message: z.string().max(2000).optional().nullable(),
});

export const verifyAgentSchema = z.object({
  agentId: z.string().min(1),
  method: z.enum(['domain', 'twitter']),
  proof: z.string().min(1).max(500),
});

export const purchaseListingSchema = z.object({
  listingId: z.string().min(1),
});

// --- Helper ---

export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): { data: T } | { error: Response } {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    return {
      error: NextResponse.json(
        { error: 'Validation failed', details: issues },
        { status: 400 }
      ),
    };
  }
  return { data: result.data };
}
