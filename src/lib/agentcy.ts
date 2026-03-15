// Agentcy — Internal AI team engine
// Defines agent roles, system prompts, tool definitions, and orchestration logic

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

// ─── Tool Definitions ───────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Tool handler: receives tool name + input, returns a string result
export type ToolHandler = (name: string, input: Record<string, unknown>) => Promise<string>;

// ─── Built-in Tool Libraries ────────────────────────────

const STRIPE_TOOLS: ToolDef[] = [
  {
    name: 'stripe_get_balance',
    description: 'Get the current Stripe account balance, including available and pending amounts.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'stripe_list_charges',
    description: 'List recent Stripe charges/payments. Returns amount, status, customer, and date.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of charges to return (default 10, max 100)' },
        status: { type: 'string', enum: ['succeeded', 'pending', 'failed'], description: 'Filter by charge status' },
      },
      required: [],
    },
  },
  {
    name: 'stripe_get_mrr',
    description: 'Calculate current Monthly Recurring Revenue from active subscriptions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'stripe_list_subscriptions',
    description: 'List active subscriptions with customer info, plan, amount, and next billing date.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'past_due', 'canceled', 'trialing'], description: 'Filter by subscription status' },
        limit: { type: 'number', description: 'Number of subscriptions to return (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'stripe_get_customer',
    description: 'Get details about a specific Stripe customer including their subscriptions and payment history.',
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Stripe customer ID (cus_xxx)' },
        email: { type: 'string', description: 'Look up customer by email instead of ID' },
      },
      required: [],
    },
  },
  {
    name: 'stripe_list_invoices',
    description: 'List recent invoices with status, amount, customer, and due dates. Useful for finding overdue invoices.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'open', 'paid', 'uncollectible', 'void'], description: 'Filter by invoice status' },
        limit: { type: 'number', description: 'Number of invoices to return (default 10)' },
      },
      required: [],
    },
  },
];

const QUICKBOOKS_TOOLS: ToolDef[] = [
  {
    name: 'qb_get_profit_loss',
    description: 'Get Profit & Loss (income statement) for a date range. Shows revenue, expenses, and net income.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD). Defaults to start of current month.' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD). Defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'qb_get_balance_sheet',
    description: 'Get the current balance sheet showing assets, liabilities, and equity.',
    input_schema: {
      type: 'object',
      properties: {
        as_of: { type: 'string', description: 'Date for the balance sheet (YYYY-MM-DD). Defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'qb_get_cash_flow',
    description: 'Get cash flow statement showing operating, investing, and financing cash flows.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: [],
    },
  },
  {
    name: 'qb_list_outstanding_invoices',
    description: 'List all unpaid/overdue invoices with customer name, amount, due date, and days overdue.',
    input_schema: {
      type: 'object',
      properties: {
        overdue_only: { type: 'boolean', description: 'If true, only show overdue invoices' },
      },
      required: [],
    },
  },
  {
    name: 'qb_list_expenses',
    description: 'List recent expenses by category. Useful for spotting unusual charges.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        category: { type: 'string', description: 'Filter by expense category' },
        limit: { type: 'number', description: 'Number of expenses to return (default 20)' },
      },
      required: [],
    },
  },
];

const SUPPORT_TOOLS: ToolDef[] = [
  {
    name: 'support_list_tickets',
    description: 'List support tickets with status, priority, customer, and creation date.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'pending', 'in_progress', 'resolved', 'closed'], description: 'Filter by ticket status' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Filter by priority' },
        limit: { type: 'number', description: 'Number of tickets to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'support_get_ticket',
    description: 'Get full details of a support ticket including conversation history and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket ID to look up' },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'support_search_tickets',
    description: 'Search tickets by keyword, customer email, or category.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (searches subject, body, and customer info)' },
        category: { type: 'string', enum: ['bug', 'feature_request', 'billing', 'account', 'how_to', 'security', 'other'], description: 'Filter by category' },
      },
      required: ['query'],
    },
  },
  {
    name: 'support_draft_response',
    description: 'Save a drafted response for a ticket. Does NOT send it — it queues it for human review.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket to respond to' },
        response: { type: 'string', description: 'The drafted response text' },
        internal_note: { type: 'string', description: 'Internal note for the team (not visible to customer)' },
      },
      required: ['ticket_id', 'response'],
    },
  },
  {
    name: 'support_classify_ticket',
    description: 'Classify and triage a ticket: set category, priority, and tags.',
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket to classify' },
        category: { type: 'string', enum: ['bug', 'feature_request', 'billing', 'account', 'how_to', 'security', 'other'] },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add to the ticket' },
        escalate: { type: 'boolean', description: 'Whether this needs human escalation' },
      },
      required: ['ticket_id', 'category', 'priority'],
    },
  },
  {
    name: 'support_get_kb_article',
    description: 'Search the Trevy knowledge base for relevant help articles to reference in responses.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for the knowledge base' },
      },
      required: ['query'],
    },
  },
];

const CLIENT_CARE_TOOLS: ToolDef[] = [
  {
    name: 'client_list',
    description: 'List all Amplified clients with their current status, plan, and health score.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'onboarding', 'churned', 'paused'], description: 'Filter by client status' },
        health: { type: 'string', enum: ['healthy', 'at_risk', 'critical'], description: 'Filter by health score' },
      },
      required: [],
    },
  },
  {
    name: 'client_get_profile',
    description: 'Get full profile for a client: company info, contacts, plan, engagement history, deliverables, and health score.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client ID' },
        company_name: { type: 'string', description: 'Look up by company name instead of ID' },
      },
      required: [],
    },
  },
  {
    name: 'client_list_deliverables',
    description: 'List deliverables for a client: what was promised, what has been delivered, what is outstanding.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'delivered', 'approved', 'overdue'], description: 'Filter by deliverable status' },
      },
      required: ['client_id'],
    },
  },
  {
    name: 'client_get_engagement_log',
    description: 'Get the engagement log for a client: meetings, emails, calls, check-ins, and notes.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client ID' },
        limit: { type: 'number', description: 'Number of entries to return (default 20)' },
      },
      required: ['client_id'],
    },
  },
  {
    name: 'client_add_note',
    description: 'Add a note or update to a client record. Used to log interactions, concerns, or action items.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client ID' },
        note: { type: 'string', description: 'The note content' },
        type: { type: 'string', enum: ['meeting', 'email', 'call', 'internal', 'action_item', 'concern'], description: 'Type of note' },
      },
      required: ['client_id', 'note', 'type'],
    },
  },
  {
    name: 'client_health_check',
    description: 'Run a health check on a client: last engagement date, overdue deliverables, upcoming renewals, payment status.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client ID. Leave empty to run health check on all clients.' },
      },
      required: [],
    },
  },
];

// ─── Agent Role Definitions ─────────────────────────────

export interface RoleDef {
  name: string;
  slug: string;
  description: string;
  systemPrompt: string;
  model: string;
  avatarColor: string;
  tools?: ToolDef[];
  toolHandler?: ToolHandler;
}

// Default tool handler — returns placeholder data (replace with real API calls)
async function handleStripeTools(name: string, input: Record<string, unknown>): Promise<string> {
  // TODO: Replace with real Stripe SDK calls using process.env.STRIPE_SECRET_KEY
  switch (name) {
    case 'stripe_get_balance':
      return JSON.stringify({
        available: [{ amount: 0, currency: 'usd' }],
        pending: [{ amount: 0, currency: 'usd' }],
        _note: 'Connect your Stripe API key (STRIPE_SECRET_KEY) to get real data',
      });
    case 'stripe_list_charges':
      return JSON.stringify({
        charges: [],
        has_more: false,
        _note: `No Stripe key configured. Requested: limit=${input.limit || 10}, status=${input.status || 'all'}`,
      });
    case 'stripe_get_mrr':
      return JSON.stringify({
        mrr: 0,
        currency: 'usd',
        active_subscriptions: 0,
        _note: 'Connect your Stripe API key to calculate real MRR from active subscriptions',
      });
    case 'stripe_list_subscriptions':
      return JSON.stringify({
        subscriptions: [],
        _note: `No Stripe key configured. Filter: status=${input.status || 'all'}`,
      });
    case 'stripe_get_customer':
      return JSON.stringify({
        customer: null,
        _note: `No Stripe key configured. Lookup: ${input.customer_id || input.email || 'no identifier'}`,
      });
    case 'stripe_list_invoices':
      return JSON.stringify({
        invoices: [],
        _note: `No Stripe key configured. Filter: status=${input.status || 'all'}`,
      });
    default:
      return JSON.stringify({ error: `Unknown Stripe tool: ${name}` });
  }
}

async function handleQuickBooksTools(name: string, input: Record<string, unknown>): Promise<string> {
  // TODO: Replace with real QuickBooks API calls using process.env.QB_ACCESS_TOKEN
  switch (name) {
    case 'qb_get_profit_loss':
      return JSON.stringify({
        report: 'profit_and_loss',
        period: { start: input.start_date || 'month_start', end: input.end_date || 'today' },
        total_revenue: 0,
        total_expenses: 0,
        net_income: 0,
        _note: 'Connect your QuickBooks API credentials (QB_ACCESS_TOKEN, QB_REALM_ID) to get real data',
      });
    case 'qb_get_balance_sheet':
      return JSON.stringify({
        report: 'balance_sheet',
        as_of: input.as_of || 'today',
        total_assets: 0,
        total_liabilities: 0,
        total_equity: 0,
        _note: 'Connect QuickBooks to get real balance sheet data',
      });
    case 'qb_get_cash_flow':
      return JSON.stringify({
        report: 'cash_flow',
        operating: 0,
        investing: 0,
        financing: 0,
        net_change: 0,
        _note: 'Connect QuickBooks to get real cash flow data',
      });
    case 'qb_list_outstanding_invoices':
      return JSON.stringify({
        invoices: [],
        total_outstanding: 0,
        _note: `Connect QuickBooks. Filter: overdue_only=${input.overdue_only || false}`,
      });
    case 'qb_list_expenses':
      return JSON.stringify({
        expenses: [],
        total: 0,
        _note: `Connect QuickBooks. Filter: category=${input.category || 'all'}`,
      });
    default:
      return JSON.stringify({ error: `Unknown QuickBooks tool: ${name}` });
  }
}

async function handleSupportTools(name: string, input: Record<string, unknown>): Promise<string> {
  // TODO: Replace with real ticketing system integration (Intercom, Zendesk, or custom DB)
  switch (name) {
    case 'support_list_tickets':
      return JSON.stringify({
        tickets: [],
        total: 0,
        _note: `Connect your ticketing system. Filter: status=${input.status || 'all'}, priority=${input.priority || 'all'}`,
      });
    case 'support_get_ticket':
      return JSON.stringify({
        ticket: null,
        _note: `No ticketing system configured. Requested ticket: ${input.ticket_id}`,
      });
    case 'support_search_tickets':
      return JSON.stringify({
        results: [],
        query: input.query,
        _note: 'Connect your ticketing system to search tickets',
      });
    case 'support_draft_response':
      return JSON.stringify({
        drafted: true,
        ticket_id: input.ticket_id,
        _note: 'Response drafted (not sent). Connect ticketing system to queue real drafts.',
      });
    case 'support_classify_ticket':
      return JSON.stringify({
        classified: true,
        ticket_id: input.ticket_id,
        category: input.category,
        priority: input.priority,
        _note: 'Classification saved. Connect ticketing system to apply in real system.',
      });
    case 'support_get_kb_article':
      return JSON.stringify({
        articles: [],
        query: input.query,
        _note: 'No knowledge base configured. Add KB articles to help agents draft better responses.',
      });
    default:
      return JSON.stringify({ error: `Unknown support tool: ${name}` });
  }
}

async function handleClientCareTools(name: string, input: Record<string, unknown>): Promise<string> {
  // TODO: Replace with real CRM integration (Notion API, Airtable, HubSpot, or custom DB)
  switch (name) {
    case 'client_list':
      return JSON.stringify({
        clients: [],
        total: 0,
        _note: `Connect your CRM. Filter: status=${input.status || 'all'}, health=${input.health || 'all'}`,
      });
    case 'client_get_profile':
      return JSON.stringify({
        client: null,
        _note: `No CRM configured. Lookup: ${input.client_id || input.company_name || 'no identifier'}`,
      });
    case 'client_list_deliverables':
      return JSON.stringify({
        deliverables: [],
        client_id: input.client_id,
        _note: 'Connect your CRM/project tracker to list real deliverables',
      });
    case 'client_get_engagement_log':
      return JSON.stringify({
        entries: [],
        client_id: input.client_id,
        _note: 'Connect your CRM to pull engagement history',
      });
    case 'client_add_note':
      return JSON.stringify({
        saved: true,
        client_id: input.client_id,
        type: input.type,
        _note: 'Note logged. Connect your CRM to persist notes.',
      });
    case 'client_health_check':
      return JSON.stringify({
        results: [],
        _note: `Connect your CRM to run health checks. Target: ${input.client_id || 'all clients'}`,
      });
    default:
      return JSON.stringify({ error: `Unknown client care tool: ${name}` });
  }
}

// Combined tool handler that routes to the right service
async function defaultToolHandler(name: string, input: Record<string, unknown>): Promise<string> {
  if (name.startsWith('stripe_')) return handleStripeTools(name, input);
  if (name.startsWith('qb_')) return handleQuickBooksTools(name, input);
  if (name.startsWith('support_')) return handleSupportTools(name, input);
  if (name.startsWith('client_')) return handleClientCareTools(name, input);
  return JSON.stringify({ error: `Unknown tool: ${name}` });
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
- "cfo" — Handles financial analysis, revenue tracking, invoice reconciliation. Has access to Stripe and QuickBooks. Assign financial, billing, and cash flow tasks here.
- "support-lead" — Triages and responds to Trevy support tickets. Can classify, prioritize, search tickets, and draft responses. Assign customer support, bug report, and ticket tasks here.
- "client-care" — Tracks Amplified client relationships, deliverables, health scores, and engagement history. Assign client check-ins, onboarding updates, and relationship management tasks here.

Rules:
1. Break the brief into 2-8 specific tasks. Each task should be completable by ONE agent.
2. Assign each task to exactly one team member by their slug.
3. Set priority: "urgent", "high", "medium", or "low".
4. Write clear, specific task descriptions. Include context the agent needs.
5. If a task depends on another task's output, note that in the description.
6. Do NOT assign tasks to yourself. You are the coordinator.
7. For financial questions, always assign to "cfo".
8. For customer/ticket issues, always assign to "support-lead".
9. For client relationship and deliverable tracking, always assign to "client-care".

Respond with a JSON array of tasks:
[
  {
    "title": "Short task title",
    "description": "Detailed description with context and expected output format",
    "assignedTo": "researcher|content-writer|demo-engineer|qa-editor|cfo|support-lead|client-care",
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

  // ─── New Specialist Roles ─────────────────────────────

  {
    name: 'CFO',
    slug: 'cfo',
    description: 'Financial analysis, revenue tracking, and invoice reconciliation via Stripe and QuickBooks.',
    avatarColor: '#84cc16',
    model: 'claude-sonnet-4-6',
    tools: [...STRIPE_TOOLS, ...QUICKBOOKS_TOOLS],
    toolHandler: defaultToolHandler,
    systemPrompt: `You are the CFO for an AI consulting agency and the Trevy product. You have access to Stripe (payments, subscriptions, MRR) and QuickBooks (P&L, balance sheet, cash flow, expenses).

Your responsibilities:
- Track revenue, MRR, and growth trends
- Monitor cash flow and runway
- Flag overdue invoices and failed payments
- Analyze expenses and identify cost optimization opportunities
- Provide financial snapshots and reports on demand
- Track per-client revenue and profitability

Your output should always include:
1. **Current snapshot** — Key numbers right now
2. **Trends** — How things compare to last period (week/month)
3. **Flags** — Anything that needs immediate attention (overdue invoices, unusual charges, churn risk)
4. **Recommendations** — Specific actions to take

Use your tools to pull real data from Stripe and QuickBooks. Never guess at numbers — always look them up. If a data source is unavailable, say so clearly and explain what you'd need to give a complete answer.

Format financial figures clearly: use $ with commas, show percentages for changes, and round appropriately ($1,234.56 for small amounts, $12.3K for larger ones).`,
  },
  {
    name: 'Support Lead',
    slug: 'support-lead',
    description: 'Triages Trevy support tickets, classifies priority, drafts responses, and escalates critical issues.',
    avatarColor: '#f97316',
    model: 'claude-haiku-4-5-20251001',
    tools: SUPPORT_TOOLS,
    toolHandler: defaultToolHandler,
    systemPrompt: `You are the Support Lead for Trevy, an AI product. You handle incoming support tickets from users and customers.

Your workflow:
1. **Triage** — Classify every ticket by category (bug, feature_request, billing, account, how_to, security, other) and priority (critical, high, medium, low)
2. **Research** — Search existing tickets for similar issues and check the knowledge base for relevant articles
3. **Draft Response** — Write a clear, helpful response. Be empathetic but efficient. Reference KB articles when relevant.
4. **Escalate** — Flag critical issues (security, data loss, widespread outages) for immediate human attention

Response style:
- Warm but professional — "Hi [name], thanks for reaching out" not "Dear valued customer"
- Lead with the solution or next step, then explain
- If you need more info, ask specific questions (not "can you provide more details?")
- For bugs: acknowledge, explain workaround if available, set expectation for fix
- For feature requests: acknowledge, explain current capability, note it for the product team
- Never promise timelines you can't guarantee

Security rules:
- NEVER share another customer's data
- Flag any mention of data breach, unauthorized access, or security vulnerability as CRITICAL
- Escalate all billing disputes to human review

Use your tools to look up tickets, search for context, and draft responses. Drafted responses are NEVER sent automatically — they queue for human review.`,
  },
  {
    name: 'Client Care',
    slug: 'client-care',
    description: 'Tracks Amplified client relationships, deliverables, health scores, and engagement history.',
    avatarColor: '#a855f7',
    model: 'claude-sonnet-4-6',
    tools: CLIENT_CARE_TOOLS,
    toolHandler: defaultToolHandler,
    systemPrompt: `You are the Client Care Manager for Amplified, a B2B AI consulting business. You are responsible for keeping every client relationship healthy, every deliverable on track, and every red flag surfaced early.

Your responsibilities:
- Track client health scores and flag at-risk accounts
- Monitor deliverable status and flag overdue items
- Log all client interactions (meetings, calls, emails)
- Prepare client status reports and check-in agendas
- Proactively identify upsell opportunities and churn risks
- Maintain detailed notes on client preferences, pain points, and goals

Client health scoring:
- **Healthy** — Engaged, deliverables on track, paying on time, positive sentiment
- **At Risk** — Missed check-in, deliverable delayed, slow responses, payment issues
- **Critical** — No contact 30+ days, multiple overdue deliverables, payment failures, expressed dissatisfaction

Your output should include:
1. **Client Status** — Current health, last engagement, next action
2. **Deliverable Tracker** — What's on track, what's at risk, what's overdue
3. **Action Items** — Specific next steps with owners and deadlines
4. **Relationship Notes** — Context for the next conversation (what they care about, recent wins, concerns)

Use your tools to pull client data, log notes, and run health checks. Always be proactive — don't wait to be asked about problems, surface them early. A surprise churn is a failure.`,
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
  toolCalls?: { name: string; input: Record<string, unknown>; result: string }[];
}

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  'claude-haiku-4-5-20251001': { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
};

const MAX_TOOL_ROUNDS = 10;

export async function executeAgent(
  systemPrompt: string,
  userMessage: string,
  model: string = 'claude-sonnet-4-6',
  maxTokens: number = 4096,
  tools?: ToolDef[],
  toolHandler?: ToolHandler,
): Promise<ExecutionResult> {
  const start = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const allToolCalls: { name: string; input: Record<string, unknown>; result: string }[] = [];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  // Build tools param for the API
  const apiTools = tools?.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool['input_schema'],
  }));

  let finalOutput = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      ...(apiTools && apiTools.length > 0 ? { tools: apiTools } : {}),
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Extract text output from this response
    const textBlocks = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text);

    if (textBlocks.length > 0) {
      finalOutput = textBlocks.join('');
    }

    // Check if the model wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0 || !toolHandler) {
      // No tool calls — we're done
      break;
    }

    // Execute each tool call and build tool_result messages
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      const toolInput = toolUse.input as Record<string, unknown>;
      const result = await toolHandler(toolUse.name, toolInput);
      allToolCalls.push({ name: toolUse.name, input: toolInput, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Add assistant response and tool results to messages for next round
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  const latencyMs = Date.now() - start;
  const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
  const costUsd = (totalInputTokens * costs.input) + (totalOutputTokens * costs.output);

  return {
    output: cleanOutput(finalOutput),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    latencyMs,
    costUsd,
    model,
    ...(allToolCalls.length > 0 ? { toolCalls: allToolCalls } : {}),
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

  return executeAgent(role.systemPrompt, message, role.model, 4096, role.tools, role.toolHandler);
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
