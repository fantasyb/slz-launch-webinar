// Agentcy — Internal AI team engine
// Defines agent roles, system prompts, tool definitions, and orchestration logic

import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import { db } from './db';

const anthropic = new Anthropic();

// Lazy-init Stripe client (only when key is available)
let _stripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key);
  return _stripe;
}

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

async function handleStripeTools(name: string, input: Record<string, unknown>): Promise<string> {
  const stripe = getStripe();
  if (!stripe) {
    return JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured. Add it to your environment variables to enable financial data.' });
  }

  switch (name) {
    case 'stripe_get_balance': {
      const balance = await stripe.balance.retrieve();
      return JSON.stringify({
        available: balance.available.map(b => ({ amount: b.amount / 100, currency: b.currency })),
        pending: balance.pending.map(b => ({ amount: b.amount / 100, currency: b.currency })),
      });
    }
    case 'stripe_list_charges': {
      const limit = Math.min((input.limit as number) || 10, 100);
      const params: Stripe.ChargeListParams = { limit };
      const charges = await stripe.charges.list(params);
      return JSON.stringify({
        charges: charges.data.map(c => ({
          id: c.id,
          amount: c.amount / 100,
          currency: c.currency,
          status: c.status,
          description: c.description,
          customer: c.customer,
          created: new Date(c.created * 1000).toISOString(),
          receipt_email: c.receipt_email,
        })),
        has_more: charges.has_more,
        total_count: charges.data.length,
      });
    }
    case 'stripe_get_mrr': {
      const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
      let mrr = 0;
      for (const sub of subs.data) {
        for (const item of sub.items.data) {
          const price = item.price;
          const amount = price.unit_amount || 0;
          if (price.recurring?.interval === 'month') {
            mrr += amount;
          } else if (price.recurring?.interval === 'year') {
            mrr += amount / 12;
          }
        }
      }
      return JSON.stringify({
        mrr: mrr / 100,
        currency: 'usd',
        active_subscriptions: subs.data.length,
        has_more: subs.has_more,
      });
    }
    case 'stripe_list_subscriptions': {
      const limit = Math.min((input.limit as number) || 10, 100);
      const params: Stripe.SubscriptionListParams = { limit };
      if (input.status) params.status = input.status as Stripe.SubscriptionListParams['status'];
      const subs = await stripe.subscriptions.list(params);
      return JSON.stringify({
        subscriptions: subs.data.map(s => ({
          id: s.id,
          status: s.status,
          customer: s.customer,
          created: new Date(s.created * 1000).toISOString(),
          start_date: new Date(s.start_date * 1000).toISOString(),
          items: s.items.data.map(i => ({
            price_id: i.price.id,
            amount: (i.price.unit_amount || 0) / 100,
            currency: i.price.currency,
            interval: i.price.recurring?.interval,
          })),
          cancel_at_period_end: s.cancel_at_period_end,
        })),
        total: subs.data.length,
        has_more: subs.has_more,
      });
    }
    case 'stripe_get_customer': {
      let customer: Stripe.Customer | Stripe.DeletedCustomer | null = null;
      if (input.customer_id) {
        customer = await stripe.customers.retrieve(input.customer_id as string);
      } else if (input.email) {
        const list = await stripe.customers.list({ email: input.email as string, limit: 1 });
        customer = list.data[0] || null;
      }
      if (!customer || customer.deleted) {
        return JSON.stringify({ customer: null, message: 'Customer not found' });
      }
      const charges = await stripe.charges.list({ customer: customer.id, limit: 5 });
      const subs = await stripe.subscriptions.list({ customer: customer.id, limit: 5 });
      return JSON.stringify({
        customer: {
          id: customer.id,
          email: customer.email,
          name: customer.name,
          created: new Date(customer.created * 1000).toISOString(),
          balance: customer.balance / 100,
          currency: customer.currency,
          metadata: customer.metadata,
        },
        recent_charges: charges.data.map(c => ({
          id: c.id, amount: c.amount / 100, status: c.status,
          created: new Date(c.created * 1000).toISOString(),
        })),
        subscriptions: subs.data.map(s => ({
          id: s.id, status: s.status,
          amount: s.items.data.reduce((sum, i) => sum + ((i.price.unit_amount || 0) / 100), 0),
        })),
      });
    }
    case 'stripe_list_invoices': {
      const limit = Math.min((input.limit as number) || 10, 100);
      const params: Stripe.InvoiceListParams = { limit };
      if (input.status) params.status = input.status as Stripe.InvoiceListParams['status'];
      const invoices = await stripe.invoices.list(params);
      return JSON.stringify({
        invoices: invoices.data.map(inv => ({
          id: inv.id,
          number: inv.number,
          customer: inv.customer,
          customer_email: inv.customer_email,
          status: inv.status,
          amount_due: (inv.amount_due || 0) / 100,
          amount_paid: (inv.amount_paid || 0) / 100,
          currency: inv.currency,
          due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
          created: new Date(inv.created * 1000).toISOString(),
          hosted_invoice_url: inv.hosted_invoice_url,
        })),
        total: invoices.data.length,
        has_more: invoices.has_more,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown Stripe tool: ${name}` });
  }
}

async function qbFetch(endpoint: string): Promise<Record<string, unknown> | null> {
  const token = process.env.QB_ACCESS_TOKEN;
  const realmId = process.env.QB_REALM_ID;
  if (!token || !realmId) return null;

  const baseUrl = process.env.QB_SANDBOX === 'true'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

  const res = await fetch(`${baseUrl}/v3/company/${realmId}/${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`QuickBooks API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReportRows(report: any): { name: string; amount: number }[] {
  const rows: { name: string; amount: number }[] = [];
  if (!report?.Rows?.Row) return rows;
  for (const row of report.Rows.Row) {
    if (row.Summary?.ColData) {
      const cols = row.Summary.ColData;
      rows.push({ name: row.group || cols[0]?.value || 'Unknown', amount: parseFloat(cols[cols.length - 1]?.value || '0') });
    } else if (row.ColData) {
      const cols = row.ColData;
      rows.push({ name: cols[0]?.value || 'Unknown', amount: parseFloat(cols[cols.length - 1]?.value || '0') });
    }
  }
  return rows;
}

async function handleQuickBooksTools(name: string, input: Record<string, unknown>): Promise<string> {
  if (!process.env.QB_ACCESS_TOKEN || !process.env.QB_REALM_ID) {
    return JSON.stringify({ error: 'QB_ACCESS_TOKEN and QB_REALM_ID not configured. Add them to your environment variables.' });
  }

  switch (name) {
    case 'qb_get_profit_loss': {
      const today = new Date().toISOString().split('T')[0];
      const monthStart = today.slice(0, 7) + '-01';
      const start = (input.start_date as string) || monthStart;
      const end = (input.end_date as string) || today;
      const data = await qbFetch(`reports/ProfitAndLoss?start_date=${start}&end_date=${end}`);
      const report = (data as Record<string, unknown>)?.['QueryResponse'] || data;
      const rows = extractReportRows(report);
      const revenue = rows.find(r => r.name === 'Income' || r.name === 'Total Income')?.amount || 0;
      const expenses = rows.find(r => r.name === 'Expenses' || r.name === 'Total Expenses')?.amount || 0;
      return JSON.stringify({
        report: 'profit_and_loss',
        period: { start, end },
        total_revenue: revenue,
        total_expenses: expenses,
        net_income: revenue - expenses,
        line_items: rows,
      });
    }
    case 'qb_get_balance_sheet': {
      const asOf = (input.as_of as string) || new Date().toISOString().split('T')[0];
      const data = await qbFetch(`reports/BalanceSheet?date_macro=Today`);
      const rows = extractReportRows(data);
      const assets = rows.find(r => r.name.includes('Asset'))?.amount || 0;
      const liabilities = rows.find(r => r.name.includes('Liabilit'))?.amount || 0;
      const equity = rows.find(r => r.name.includes('Equity'))?.amount || 0;
      return JSON.stringify({
        report: 'balance_sheet',
        as_of: asOf,
        total_assets: assets,
        total_liabilities: liabilities,
        total_equity: equity,
        line_items: rows,
      });
    }
    case 'qb_get_cash_flow': {
      const today = new Date().toISOString().split('T')[0];
      const start = (input.start_date as string) || today.slice(0, 7) + '-01';
      const end = (input.end_date as string) || today;
      const data = await qbFetch(`reports/CashFlow?start_date=${start}&end_date=${end}`);
      const rows = extractReportRows(data);
      const operating = rows.find(r => r.name.includes('Operating'))?.amount || 0;
      const investing = rows.find(r => r.name.includes('Investing'))?.amount || 0;
      const financing = rows.find(r => r.name.includes('Financing'))?.amount || 0;
      return JSON.stringify({
        report: 'cash_flow',
        period: { start, end },
        operating,
        investing,
        financing,
        net_change: operating + investing + financing,
        line_items: rows,
      });
    }
    case 'qb_list_outstanding_invoices': {
      const data = await qbFetch(`query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate")}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qr = data as any;
      const invoices = (qr?.QueryResponse?.Invoice || []).map((inv: Record<string, unknown>) => {
        const dueDate = inv.DueDate as string;
        const now = new Date();
        const due = new Date(dueDate);
        const daysOverdue = Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
        return {
          id: inv.Id,
          customer: (inv.CustomerRef as Record<string, unknown>)?.name,
          amount: inv.TotalAmt,
          balance: inv.Balance,
          due_date: dueDate,
          days_overdue: daysOverdue > 0 ? daysOverdue : 0,
          is_overdue: daysOverdue > 0,
        };
      });
      const filtered = input.overdue_only
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? invoices.filter((i: any) => i.is_overdue)
        : invoices;
      return JSON.stringify({
        invoices: filtered,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        total_outstanding: filtered.reduce((s: number, i: any) => s + (i.balance || 0), 0),
        count: filtered.length,
      });
    }
    case 'qb_list_expenses': {
      const today = new Date().toISOString().split('T')[0];
      const start = (input.start_date as string) || today.slice(0, 7) + '-01';
      const limit = (input.limit as number) || 20;
      let query = `SELECT * FROM Purchase WHERE TxnDate >= '${start}' ORDERBY TxnDate DESC MAXRESULTS ${limit}`;
      if (input.category) {
        query = `SELECT * FROM Purchase WHERE TxnDate >= '${start}' AND AccountRef = '${input.category}' ORDERBY TxnDate DESC MAXRESULTS ${limit}`;
      }
      const data = await qbFetch(`query?query=${encodeURIComponent(query)}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qr = data as any;
      const expenses = (qr?.QueryResponse?.Purchase || []).map((exp: Record<string, unknown>) => ({
        id: exp.Id,
        amount: exp.TotalAmt,
        date: exp.TxnDate,
        account: (exp.AccountRef as Record<string, unknown>)?.name,
        vendor: (exp.EntityRef as Record<string, unknown>)?.name,
        memo: exp.PrivateNote,
      }));
      return JSON.stringify({
        expenses,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        total: expenses.reduce((s: number, e: any) => s + (e.amount || 0), 0),
        count: expenses.length,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown QuickBooks tool: ${name}` });
  }
}

async function handleSupportTools(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'support_list_tickets': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};
      if (input.status) where.status = input.status;
      if (input.priority) where.priority = input.priority;
      const tickets = await db.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: (input.limit as number) || 20,
        include: { responses: { take: 1, orderBy: { createdAt: 'desc' } } },
      });
      return JSON.stringify({
        tickets: tickets.map(t => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
          category: t.category,
          customerEmail: t.customerEmail,
          customerName: t.customerName,
          escalated: t.escalated,
          tags: t.tags,
          createdAt: t.createdAt.toISOString(),
          lastResponse: t.responses[0]?.createdAt?.toISOString() || null,
        })),
        total: tickets.length,
      });
    }
    case 'support_get_ticket': {
      const ticket = await db.supportTicket.findUnique({
        where: { id: input.ticket_id as string },
        include: { responses: { orderBy: { createdAt: 'asc' } } },
      });
      if (!ticket) return JSON.stringify({ ticket: null, message: 'Ticket not found' });
      return JSON.stringify({
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          body: ticket.body,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          tags: ticket.tags,
          customerEmail: ticket.customerEmail,
          customerName: ticket.customerName,
          escalated: ticket.escalated,
          createdAt: ticket.createdAt.toISOString(),
          resolvedAt: ticket.resolvedAt?.toISOString() || null,
          conversation: ticket.responses.map(r => ({
            id: r.id,
            message: r.message,
            author: r.author,
            isInternal: r.isInternal,
            isDraft: r.isDraft,
            createdAt: r.createdAt.toISOString(),
          })),
        },
      });
    }
    case 'support_search_tickets': {
      const query = input.query as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {
        OR: [
          { subject: { contains: query, mode: 'insensitive' } },
          { body: { contains: query, mode: 'insensitive' } },
          { customerEmail: { contains: query, mode: 'insensitive' } },
        ],
      };
      if (input.category) where.category = input.category;
      const tickets = await db.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return JSON.stringify({
        results: tickets.map(t => ({
          id: t.id,
          subject: t.subject,
          status: t.status,
          priority: t.priority,
          category: t.category,
          customerEmail: t.customerEmail,
          createdAt: t.createdAt.toISOString(),
        })),
        query,
        total: tickets.length,
      });
    }
    case 'support_draft_response': {
      const response = await db.ticketResponse.create({
        data: {
          ticketId: input.ticket_id as string,
          message: input.response as string,
          isDraft: true,
          isInternal: false,
          author: 'agent',
        },
      });
      if (input.internal_note) {
        await db.ticketResponse.create({
          data: {
            ticketId: input.ticket_id as string,
            message: input.internal_note as string,
            isDraft: false,
            isInternal: true,
            author: 'agent',
          },
        });
      }
      // Move ticket to pending (agent has responded, awaiting human review)
      await db.supportTicket.update({
        where: { id: input.ticket_id as string },
        data: { status: 'pending' },
      });
      return JSON.stringify({
        drafted: true,
        response_id: response.id,
        ticket_id: input.ticket_id,
        message: 'Response drafted and queued for human review. NOT sent to customer.',
      });
    }
    case 'support_classify_ticket': {
      const updateData: Record<string, unknown> = {
        category: input.category,
        priority: input.priority,
      };
      if (input.tags) updateData.tags = input.tags;
      if (input.escalate) updateData.escalated = true;
      const updated = await db.supportTicket.update({
        where: { id: input.ticket_id as string },
        data: updateData,
      });
      return JSON.stringify({
        classified: true,
        ticket_id: updated.id,
        category: updated.category,
        priority: updated.priority,
        tags: updated.tags,
        escalated: updated.escalated,
      });
    }
    case 'support_get_kb_article': {
      const query = input.query as string;
      const articles = await db.kBArticle.findMany({
        where: {
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { content: { contains: query, mode: 'insensitive' } },
            { tags: { hasSome: query.toLowerCase().split(/\s+/) } },
          ],
        },
        take: 5,
      });
      return JSON.stringify({
        articles: articles.map(a => ({
          id: a.id,
          title: a.title,
          content: a.content,
          category: a.category,
          tags: a.tags,
        })),
        query,
        total: articles.length,
      });
    }
    default:
      return JSON.stringify({ error: `Unknown support tool: ${name}` });
  }
}

async function handleClientCareTools(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'client_list': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};
      if (input.status) where.status = input.status;
      if (input.health) where.health = input.health;
      const clients = await db.client.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        include: {
          contacts: { where: { isPrimary: true }, take: 1 },
          _count: { select: { deliverables: true, engagementLog: true } },
        },
      });
      return JSON.stringify({
        clients: clients.map(c => ({
          id: c.id,
          companyName: c.companyName,
          status: c.status,
          plan: c.plan,
          health: c.health,
          healthScore: c.healthScore,
          mrr: c.mrr,
          primaryContact: c.contacts[0]?.name || null,
          primaryEmail: c.contacts[0]?.email || null,
          deliverableCount: c._count.deliverables,
          engagementCount: c._count.engagementLog,
          contractEnd: c.contractEnd?.toISOString() || null,
        })),
        total: clients.length,
      });
    }
    case 'client_get_profile': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = {};
      if (input.client_id) where.id = input.client_id;
      else if (input.company_name) where.companyName = { contains: input.company_name, mode: 'insensitive' };
      else return JSON.stringify({ error: 'Provide client_id or company_name' });

      const client = await db.client.findFirst({
        where,
        include: {
          contacts: true,
          deliverables: { orderBy: { createdAt: 'desc' }, take: 10 },
          engagementLog: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      });
      if (!client) return JSON.stringify({ client: null, message: 'Client not found' });

      const overdueDeliverables = client.deliverables.filter(
        d => d.status !== 'delivered' && d.status !== 'approved' && d.dueDate && d.dueDate < new Date()
      );
      return JSON.stringify({
        client: {
          id: client.id,
          companyName: client.companyName,
          status: client.status,
          plan: client.plan,
          health: client.health,
          healthScore: client.healthScore,
          mrr: client.mrr,
          contractStart: client.contractStart?.toISOString() || null,
          contractEnd: client.contractEnd?.toISOString() || null,
          notes: client.notes,
          contacts: client.contacts.map(c => ({
            name: c.name, email: c.email, role: c.role, isPrimary: c.isPrimary,
          })),
          recentDeliverables: client.deliverables.map(d => ({
            id: d.id, title: d.title, status: d.status,
            dueDate: d.dueDate?.toISOString() || null,
            deliveredAt: d.deliveredAt?.toISOString() || null,
          })),
          overdueCount: overdueDeliverables.length,
          recentEngagement: client.engagementLog.map(e => ({
            type: e.type, content: e.content, author: e.author,
            createdAt: e.createdAt.toISOString(),
          })),
          lastEngagement: client.engagementLog[0]?.createdAt?.toISOString() || null,
        },
      });
    }
    case 'client_list_deliverables': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { clientId: input.client_id as string };
      if (input.status) where.status = input.status;
      const deliverables = await db.deliverable.findMany({
        where,
        orderBy: { dueDate: 'asc' },
      });
      return JSON.stringify({
        deliverables: deliverables.map(d => ({
          id: d.id,
          title: d.title,
          description: d.description,
          status: d.status,
          dueDate: d.dueDate?.toISOString() || null,
          deliveredAt: d.deliveredAt?.toISOString() || null,
          isOverdue: d.status !== 'delivered' && d.status !== 'approved' && d.dueDate && d.dueDate < new Date(),
        })),
        client_id: input.client_id,
        total: deliverables.length,
      });
    }
    case 'client_get_engagement_log': {
      const entries = await db.engagementEntry.findMany({
        where: { clientId: input.client_id as string },
        orderBy: { createdAt: 'desc' },
        take: (input.limit as number) || 20,
      });
      return JSON.stringify({
        entries: entries.map(e => ({
          id: e.id,
          type: e.type,
          content: e.content,
          author: e.author,
          createdAt: e.createdAt.toISOString(),
        })),
        client_id: input.client_id,
        total: entries.length,
      });
    }
    case 'client_add_note': {
      const entry = await db.engagementEntry.create({
        data: {
          clientId: input.client_id as string,
          type: input.type as string,
          content: input.note as string,
          author: 'agent',
        },
      });
      return JSON.stringify({
        saved: true,
        entry_id: entry.id,
        client_id: input.client_id,
        type: input.type,
      });
    }
    case 'client_health_check': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = input.client_id ? { id: input.client_id } : {};
      const clients = await db.client.findMany({
        where,
        include: {
          deliverables: true,
          engagementLog: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });

      const now = new Date();
      const results = clients.map(client => {
        const overdueDeliverables = client.deliverables.filter(
          d => d.status !== 'delivered' && d.status !== 'approved' && d.dueDate && d.dueDate < now
        );
        const lastEngagement = client.engagementLog[0]?.createdAt;
        const daysSinceEngagement = lastEngagement
          ? Math.floor((now.getTime() - lastEngagement.getTime()) / (1000 * 60 * 60 * 24))
          : 999;
        const contractEnding = client.contractEnd
          ? Math.floor((client.contractEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : null;

        // Compute health
        let health = 'healthy';
        let score = client.healthScore;
        if (daysSinceEngagement > 30 || overdueDeliverables.length > 2) {
          health = 'critical';
          score = Math.min(score, 30);
        } else if (daysSinceEngagement > 14 || overdueDeliverables.length > 0) {
          health = 'at_risk';
          score = Math.min(score, 60);
        }

        // Update health in DB (fire and forget)
        db.client.update({
          where: { id: client.id },
          data: { health, healthScore: score },
        }).catch(() => {});

        return {
          id: client.id,
          companyName: client.companyName,
          status: client.status,
          health,
          healthScore: score,
          daysSinceEngagement,
          lastEngagement: lastEngagement?.toISOString() || null,
          overdueDeliverables: overdueDeliverables.length,
          contractEndingInDays: contractEnding,
          flags: [
            ...(daysSinceEngagement > 14 ? [`No engagement in ${daysSinceEngagement} days`] : []),
            ...(overdueDeliverables.length > 0 ? [`${overdueDeliverables.length} overdue deliverables`] : []),
            ...(contractEnding !== null && contractEnding < 30 ? [`Contract ending in ${contractEnding} days`] : []),
          ],
        };
      });

      return JSON.stringify({
        results,
        total: results.length,
        at_risk: results.filter(r => r.health === 'at_risk').length,
        critical: results.filter(r => r.health === 'critical').length,
      });
    }
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
