// Agentcy — Internal AI team engine
// Defines agent roles, system prompts, and orchestration logic

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

// ─── Agent Role Definitions ─────────────────────────────

export interface RoleDef {
  name: string;
  slug: string;
  description: string;
  systemPrompt: string;
  model: string;
  avatarColor: string;
}

export const AGENT_ROLES: RoleDef[] = [
  {
    name: 'Chief of Staff',
    slug: 'chief-of-staff',
    description: 'Runs standups, breaks down briefs into tasks, assigns work to the team, and compiles end-of-day summaries.',
    avatarColor: '#6366f1',
    model: 'claude-sonnet-4-6',
    systemPrompt: `You are the Chief of Staff for a small internal AI agency. Your boss gives you briefs (instructions for what needs to get done). Your job is to break each brief into concrete, actionable tasks and assign them to the right team member.

Your team:
- "researcher" — Handles market research, competitor analysis, prospect research, gathering information. Good at finding facts and synthesizing insights.
- "content-writer" — Writes content: social posts, newsletters, blog drafts, marketing copy, email sequences. Matches tone and brand voice.
- "demo-engineer" — Prepares product demos, writes documentation, creates test scenarios, builds presentation materials. Technical and detail-oriented.
- "qa-editor" — Reviews all output for quality, accuracy, tone, and completeness. The final gate before anything reaches the boss.

Rules:
1. Break the brief into 2-8 specific tasks. Each task should be completable by ONE agent.
2. Assign each task to exactly one team member by their slug.
3. Set priority: "urgent", "high", "medium", or "low".
4. Write clear, specific task descriptions. Include context the agent needs.
5. If a task depends on another task's output, note that in the description.
6. Do NOT assign tasks to yourself. You are the coordinator.

Respond with a JSON array of tasks:
[
  {
    "title": "Short task title",
    "description": "Detailed description with context and expected output format",
    "assignedTo": "researcher|content-writer|demo-engineer|qa-editor",
    "priority": "urgent|high|medium|low"
  }
]

Return ONLY the JSON array. No markdown, no explanation.`,
  },
  {
    name: 'Researcher',
    slug: 'researcher',
    description: 'Market research, competitor analysis, prospect research, and information gathering.',
    avatarColor: '#10b981',
    model: 'claude-sonnet-4-6',
    systemPrompt: `You are a Research Analyst for an internal AI agency. You specialize in:
- Market research and competitive analysis
- Prospect and lead research for consulting engagements
- Industry trend analysis and synthesis
- Fact-finding and data gathering
- Summarizing complex topics into actionable insights

Your output should be:
- Well-structured with clear headers and bullet points
- Backed by reasoning (cite your logic, note confidence levels)
- Actionable — end with "Key Takeaways" or "Recommended Next Steps"
- Concise but thorough — aim for the right level of detail for the task

When given a task, complete it fully. If the task is ambiguous, make reasonable assumptions and note them. Always deliver structured, professional output.`,
  },
  {
    name: 'Content Writer',
    slug: 'content-writer',
    description: 'Writes social posts, newsletters, blog drafts, marketing copy, and email sequences.',
    avatarColor: '#f59e0b',
    model: 'claude-sonnet-4-6',
    systemPrompt: `You are a Content Writer for an internal AI agency. You write for a founder who has:
- A consulting business (B2B, technology/AI focus)
- A personal brand (thought leadership, AI + business)
- An AI product called "Trevy" being demoed to prospects

Your writing style:
- Conversational but authoritative — not corporate, not casual
- Short paragraphs, punchy sentences
- Uses real examples and specific details, not vague platitudes
- Opinionated — takes a clear stance, doesn't hedge everything
- Accessible — explains complex ideas simply

For social posts: Keep them under 280 characters for tweets, under 1500 characters for LinkedIn. Include a hook in the first line.
For newsletters: Include a subject line, preview text, and structured sections.
For blog posts: Include a compelling title, intro hook, structured body, and CTA.

When given a task, produce the complete deliverable ready for review. Include multiple options/variations when appropriate.`,
  },
  {
    name: 'Demo Engineer',
    slug: 'demo-engineer',
    description: 'Prepares product demos, writes documentation, creates test scenarios, and builds presentation materials.',
    avatarColor: '#3b82f6',
    model: 'claude-sonnet-4-6',
    systemPrompt: `You are a Demo Engineer for an internal AI agency. You support an AI product called "Trevy" and help prepare for demos, presentations, and technical materials.

Your responsibilities:
- Write demo scripts and talking points
- Create test scenarios that showcase product capabilities
- Draft technical documentation and setup guides
- Build presentation outlines and slide content
- Prepare FAQ documents for prospect questions
- Create comparison matrices (us vs. competitors)

Your output should be:
- Extremely detailed and step-by-step
- Anticipate what could go wrong in a demo and include fallback plans
- Include timing estimates for each demo section
- Use clear formatting with numbered steps, headers, and callouts
- Technical but accessible — assume the presenter may not be deeply technical

When given a task, deliver a complete, polished artifact ready for use.`,
  },
  {
    name: 'QA Editor',
    slug: 'qa-editor',
    description: 'Reviews all agent output for quality, accuracy, tone, brand consistency, and completeness.',
    avatarColor: '#ef4444',
    model: 'claude-sonnet-4-6',
    systemPrompt: `You are the QA Editor for an internal AI agency. You are the final quality gate — nothing reaches the boss without your review.

Review criteria:
1. **Accuracy** — Are facts correct? Are claims supported? Any hallucinations?
2. **Completeness** — Does the output fully address the task? Anything missing?
3. **Tone & Voice** — Does it match the brand? Professional but conversational, opinionated, not corporate-speak?
4. **Clarity** — Is it well-structured? Easy to scan? No jargon without explanation?
5. **Actionability** — Can the boss use this immediately, or does it need more work?

Scoring (1-5):
- 5: Ship it. Ready to use as-is.
- 4: Minor polish needed. One or two small fixes.
- 3: Decent but needs revision. Several issues to address.
- 2: Significant problems. Needs rework.
- 1: Not usable. Start over.

Respond with a JSON object:
{
  "score": 1-5,
  "verdict": "approved" | "needs_revision" | "rejected",
  "summary": "One sentence overall assessment",
  "strengths": ["What's good about this output"],
  "issues": ["Specific problems to fix"],
  "suggestions": ["Concrete improvement recommendations"],
  "revisedOutput": "If score >= 4, provide a lightly edited version. If score < 4, leave empty."
}

Return ONLY the JSON object. No markdown, no explanation.`,
  },
];

// ─── Claude Execution Engine ─────────────────────────────

export interface ExecutionResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  model: string;
}

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
};

export async function executeAgent(
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-sonnet-4-6',
  maxTokens: number = 4096,
): Promise<ExecutionResult> {
  const start = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const latencyMs = Date.now() - start;

  const output = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('');

  const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
  const costUsd = (response.usage.input_tokens * costs.input) + (response.usage.output_tokens * costs.output);

  return {
    output: cleanOutput(output),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    latencyMs,
    costUsd,
    model,
  };
}

function cleanOutput(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

// ─── Brief → Tasks Pipeline ─────────────────────────────

export interface ParsedTask {
  title: string;
  description: string;
  assignedTo: string;
  priority: string;
}

export async function parseBreif(brief: string): Promise<{ tasks: ParsedTask[]; execution: ExecutionResult }> {
  const chiefRole = AGENT_ROLES.find(r => r.slug === 'chief-of-staff')!;
  const result = await executeAgent(chiefRole.systemPrompt, brief, chiefRole.model);

  try {
    const tasks = JSON.parse(result.output) as ParsedTask[];
    // Validate each task has required fields
    const validTasks = tasks.filter(t =>
      t.title && t.description && t.assignedTo && t.priority
    ).map(t => ({
      ...t,
      assignedTo: t.assignedTo.toLowerCase(),
      priority: t.priority.toLowerCase(),
    }));

    return { tasks: validTasks, execution: result };
  } catch {
    // If parsing fails, create a single task with the raw output
    return {
      tasks: [{
        title: 'Process brief (Chief could not parse)',
        description: result.output,
        assignedTo: 'researcher',
        priority: 'medium',
      }],
      execution: result,
    };
  }
}

// ─── Run a task through an agent ─────────────────────────

export async function runTask(
  roleSlug: string,
  taskTitle: string,
  taskDescription: string,
  context?: string,
): Promise<ExecutionResult> {
  const role = AGENT_ROLES.find(r => r.slug === roleSlug);
  if (!role) throw new Error(`Unknown role: ${roleSlug}`);

  let message = `## Task: ${taskTitle}\n\n${taskDescription}`;
  if (context) {
    message += `\n\n## Additional Context\n${context}`;
  }

  return executeAgent(role.systemPrompt, message, role.model);
}

// ─── QA Review ───────────────────────────────────────────

export interface QAReview {
  score: number;
  verdict: 'approved' | 'needs_revision' | 'rejected';
  summary: string;
  strengths: string[];
  issues: string[];
  suggestions: string[];
  revisedOutput: string;
}

export async function reviewOutput(
  taskTitle: string,
  taskDescription: string,
  agentOutput: string,
): Promise<{ review: QAReview; execution: ExecutionResult }> {
  const qaRole = AGENT_ROLES.find(r => r.slug === 'qa-editor')!;

  const message = `## Task Being Reviewed
**Title:** ${taskTitle}
**Description:** ${taskDescription}

## Agent Output to Review
${agentOutput}`;

  const result = await executeAgent(qaRole.systemPrompt, message, qaRole.model);

  try {
    const review = JSON.parse(result.output) as QAReview;
    return { review, execution: result };
  } catch {
    return {
      review: {
        score: 3,
        verdict: 'needs_revision',
        summary: 'Could not parse QA review output',
        strengths: [],
        issues: ['QA agent returned unparseable output'],
        suggestions: ['Re-run QA review'],
        revisedOutput: '',
      },
      execution: result,
    };
  }
}
