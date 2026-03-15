// Agent Memory System — persistent memory for the agentcy team
// Two layers: curated Memory records + append-only DailyNotes
// Search: Postgres full-text + tag matching + recency weighting

import { db } from './db';
import { executeAgent } from './agentcy';

// ─── Memory Search ──────────────────────────────────────

export interface MemorySearchOptions {
  agentSlug?: string;     // Filter to specific agent's memories (null = all agents)
  query: string;          // Natural language query
  types?: string[];       // Filter by memory type
  tags?: string[];        // Filter by tags
  limit?: number;         // Max results (default 20)
  includeExpired?: boolean;
  minImportance?: number; // Only return memories above this importance
}

export interface MemoryResult {
  id: string;
  agentSlug: string;
  type: string;
  content: string;
  tags: string[];
  importance: number;
  createdAt: Date;
  relevanceScore: number; // Combined score from search ranking
}

export async function searchMemories(options: MemorySearchOptions): Promise<MemoryResult[]> {
  const {
    agentSlug,
    query,
    types,
    tags,
    limit = 20,
    includeExpired = false,
    minImportance = 1,
  } = options;

  // Extract keywords from the query for matching
  const keywords = extractKeywords(query);

  // Build the where clause
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (agentSlug) {
    conditions.push(`"agentSlug" = $${paramIndex++}`);
    params.push(agentSlug);
  }

  if (!includeExpired) {
    conditions.push(`("expiresAt" IS NULL OR "expiresAt" > NOW())`);
  }

  if (minImportance > 1) {
    conditions.push(`"importance" >= $${paramIndex++}`);
    params.push(minImportance);
  }

  if (types && types.length > 0) {
    conditions.push(`"type" = ANY($${paramIndex++})`);
    params.push(types);
  }

  if (tags && tags.length > 0) {
    conditions.push(`"tags" && $${paramIndex++}`);
    params.push(tags);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Score = keyword match score + tag overlap score + importance weight + recency decay
  // Keyword matching: count how many query keywords appear in content (case-insensitive)
  const keywordScoreExpr = keywords.length > 0
    ? keywords.map((kw, i) => {
        params.push(`%${kw.toLowerCase()}%`);
        return `CASE WHEN LOWER("content") LIKE $${paramIndex++} THEN 1 ELSE 0 END`;
      }).join(' + ')
    : '0';

  // Tag overlap: count matching tags
  const tagScoreExpr = keywords.length > 0
    ? (() => {
        params.push(keywords.map(k => k.toLowerCase()));
        return `COALESCE(array_length(ARRAY(SELECT unnest("tags") INTERSECT SELECT unnest($${paramIndex++}::text[])), 1), 0)`;
      })()
    : '0';

  // Recency: exponential decay over 30 days
  const recencyExpr = `EXP(-EXTRACT(EPOCH FROM (NOW() - "createdAt")) / (30 * 86400))`;

  const sql = `
    SELECT
      "id", "agentSlug", "type", "content", "tags", "importance", "createdAt",
      (
        (${keywordScoreExpr}) * 3.0 +
        (${tagScoreExpr}) * 2.0 +
        ("importance" / 10.0) * 1.5 +
        (${recencyExpr}) * 1.0
      ) AS "relevanceScore"
    FROM "Memory"
    ${whereClause}
    ORDER BY "relevanceScore" DESC, "importance" DESC, "createdAt" DESC
    LIMIT $${paramIndex++}
  `;
  params.push(limit);

  const results = await db.$queryRawUnsafe(sql, ...params) as MemoryResult[];

  return results.map(r => ({
    ...r,
    relevanceScore: Number(r.relevanceScore),
    tags: Array.isArray(r.tags) ? r.tags : [],
  }));
}

// ─── Memory Write ───────────────────────────────────────

export interface MemoryWrite {
  agentId: string;
  agentSlug: string;
  type: string;
  content: string;
  tags: string[];
  source?: string;
  importance?: number;
  expiresAt?: Date;
}

export async function writeMemory(memory: MemoryWrite) {
  // Check for near-duplicate: same agent, same type, very similar content
  const existing = await db.memory.findFirst({
    where: {
      agentSlug: memory.agentSlug,
      type: memory.type,
      content: { contains: memory.content.slice(0, 50) },
    },
  });

  if (existing) {
    // Update existing memory instead of creating duplicate
    return db.memory.update({
      where: { id: existing.id },
      data: {
        content: memory.content,
        tags: { set: memory.tags },
        importance: memory.importance || existing.importance,
        updatedAt: new Date(),
      },
    });
  }

  return db.memory.create({
    data: {
      agentId: memory.agentId,
      agentSlug: memory.agentSlug,
      type: memory.type,
      content: memory.content,
      tags: memory.tags,
      source: memory.source,
      importance: memory.importance || 5,
      expiresAt: memory.expiresAt,
    },
  });
}

export async function writeMemories(memories: MemoryWrite[]) {
  const results = [];
  for (const mem of memories) {
    results.push(await writeMemory(mem));
  }
  return results;
}

// ─── Daily Notes ────────────────────────────────────────

export async function appendDailyNote(
  agentSlug: string,
  content: string,
  handoffId?: string,
  type: string = 'work',
) {
  const today = new Date().toISOString().split('T')[0];
  const entry = {
    timestamp: new Date().toISOString(),
    content,
    handoffId,
    type,
  };

  const existing = await db.dailyNote.findUnique({
    where: { date_agentSlug: { date: today, agentSlug } },
  });

  if (existing) {
    const entries = Array.isArray(existing.entries) ? existing.entries as Array<Record<string, unknown>> : [];
    entries.push(entry);
    return db.dailyNote.update({
      where: { id: existing.id },
      data: { entries: entries as unknown as import('@prisma/client').Prisma.InputJsonValue },
    });
  }

  return db.dailyNote.create({
    data: {
      date: today,
      agentSlug,
      entries: [entry] as unknown as import('@prisma/client').Prisma.InputJsonValue,
    },
  });
}

export async function getDailyNotes(agentSlug: string, days: number = 2): Promise<string> {
  const notes = await db.dailyNote.findMany({
    where: { agentSlug },
    orderBy: { date: 'desc' },
    take: days,
  });

  if (notes.length === 0) return '';

  return notes.map(note => {
    const entries = Array.isArray(note.entries) ? note.entries as Array<Record<string, unknown>> : [];
    const entryText = entries.map(e =>
      `  [${(e.timestamp as string)?.slice(11, 16) || '??:??'}] ${e.content}`
    ).join('\n');
    return `## ${note.date}\n${entryText}`;
  }).join('\n\n');
}

// ─── Memory Extraction ─────────────────────────────────
// After a handoff completes, extract key facts from the output

const EXTRACTION_PROMPT = `You are a memory curator for an AI agent team. Given the task and output below, extract key facts, decisions, metrics, and patterns that should be remembered for future tasks.

Rules:
1. Extract 1-5 distinct memories. Each should be a single, atomic fact.
2. Be concise — one sentence per memory.
3. Include specific numbers, names, dates when present.
4. Tag each memory with relevant keywords (lowercase, hyphenated).
5. Classify each memory by type:
   - "fact" — A piece of information (e.g., "Client X uses React")
   - "decision" — A choice that was made (e.g., "We decided to use Stripe for billing")
   - "metric" — A number or measurement (e.g., "MRR is $12,400 as of March 2026")
   - "client" — Client-specific information (e.g., "Acme Corp prefers weekly check-ins")
   - "pattern" — A recurring theme or insight (e.g., "Support tickets spike on Mondays")
   - "preference" — A user/team preference (e.g., "Boss prefers bullet points over prose")
6. Rate importance 1-10. Metrics and decisions are usually 7-9. Routine facts are 3-5.
7. If a metric is time-sensitive, set expiresInDays (e.g., 30 for monthly metrics).

Respond with a JSON array:
[
  {
    "type": "fact|decision|metric|client|pattern|preference",
    "content": "The concise memory to store",
    "tags": ["tag1", "tag2"],
    "importance": 1-10,
    "expiresInDays": null
  }
]

Return ONLY the JSON array. No markdown, no explanation. If there is nothing worth remembering, return [].`;

export interface ExtractedMemory {
  type: string;
  content: string;
  tags: string[];
  importance: number;
  expiresInDays: number | null;
}

export async function extractMemories(
  taskTitle: string,
  taskDescription: string,
  agentOutput: string,
  agentSlug: string,
): Promise<ExtractedMemory[]> {
  const message = `## Task\n**Title:** ${taskTitle}\n**Description:** ${taskDescription}\n\n## Agent Output\n${agentOutput}\n\n## Agent\n${agentSlug}`;

  // Use Haiku for extraction — it's fast and cheap
  const result = await executeAgent(
    EXTRACTION_PROMPT,
    message,
    'claude-haiku-4-5-20251001',
    2048,
  );

  try {
    const memories = JSON.parse(result.output) as ExtractedMemory[];
    return memories.filter(m => m.content && m.type && m.tags);
  } catch {
    return [];
  }
}

// ─── Build Context for Agent ────────────────────────────
// Before running an agent, build a context string with relevant memories + daily notes

export async function buildMemoryContext(
  agentSlug: string,
  taskTitle: string,
  taskDescription: string,
): Promise<string> {
  // 1. Get agent's own memories relevant to this task
  const ownMemories = await searchMemories({
    agentSlug,
    query: `${taskTitle} ${taskDescription}`,
    limit: 10,
    minImportance: 3,
  });

  // 2. Get shared/cross-agent memories relevant to this task
  const sharedMemories = await searchMemories({
    query: `${taskTitle} ${taskDescription}`,
    limit: 5,
    minImportance: 6,
  });

  // Deduplicate
  const allMemories = [...ownMemories];
  for (const sm of sharedMemories) {
    if (!allMemories.find(m => m.id === sm.id)) {
      allMemories.push(sm);
    }
  }

  // Sort by relevance
  allMemories.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const topMemories = allMemories.slice(0, 12);

  // 3. Get recent daily notes
  const dailyNotes = await getDailyNotes(agentSlug, 2);

  // 4. Build context string
  const parts: string[] = [];

  if (topMemories.length > 0) {
    parts.push('## Relevant Memories');
    for (const m of topMemories) {
      const age = Math.floor((Date.now() - new Date(m.createdAt).getTime()) / 86400000);
      const ageStr = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age}d ago`;
      parts.push(`- [${m.type}] ${m.content} (${ageStr}, importance: ${m.importance}/10)`);
    }
  }

  if (dailyNotes) {
    parts.push('\n## Recent Activity Log');
    parts.push(dailyNotes);
  }

  return parts.join('\n');
}

// ─── Helpers ────────────────────────────────────────────

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
    'if', 'while', 'about', 'what', 'which', 'who', 'whom', 'this', 'that',
    'these', 'those', 'am', 'it', 'its', 'my', 'your', 'his', 'her', 'our',
    'their', 'me', 'him', 'us', 'them', 'i', 'you', 'he', 'she', 'we', 'they',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 15); // Cap keywords to prevent query explosion
}
