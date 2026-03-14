// Benchmark test scenarios with ground truth for measuring generalist vs specialist vs orchestrator

export interface TestCase {
  id: string;
  input: string;
  expectedOutput: Record<string, unknown>;
}

export interface BenchmarkScenario {
  id: string;
  name: string;
  description: string;
  generalistPrompt: string;
  specialistPrompt: string;
  orchestratorPrompt: string;
  testCases: TestCase[];
  scoreOutput: (output: string, expected: Record<string, unknown>) => number;
}

// --- Scenario 1: Structured Data Extraction from messy text ---

const extractionCases: TestCase[] = [
  {
    id: 'ext-1',
    input: `hey so the invoice is from Acme Corp, invoice number INV-2024-0847,
dated january 15 2024. total amount is $4,250.00 and its due by feb 15 2024.
the contact is Sarah Chen, sarah@acmecorp.io, phone 415-555-0192.
payment terms are net 30. PO number PO-88712.`,
    expectedOutput: {
      vendor: 'Acme Corp',
      invoiceNumber: 'INV-2024-0847',
      date: '2024-01-15',
      amount: 4250.00,
      dueDate: '2024-02-15',
      contactName: 'Sarah Chen',
      contactEmail: 'sarah@acmecorp.io',
      contactPhone: '415-555-0192',
      paymentTerms: 'Net 30',
      poNumber: 'PO-88712',
    },
  },
  {
    id: 'ext-2',
    input: `Invoice from TechStack Solutions LLC
inv# TS-9921 | 03/22/2024
Bill to: Widget Industries
Items:
- Cloud hosting (March): $1,200/mo
- API calls overage: $340.50
- Premium support: $500
Subtotal: $2,040.50
Tax (8.5%): $173.44
TOTAL: $2,213.94
Due: April 21, 2024
Contact: Mike Rivera, mike.r@techstack.io
Terms: Net 30 | PO: WI-2024-445`,
    expectedOutput: {
      vendor: 'TechStack Solutions LLC',
      invoiceNumber: 'TS-9921',
      date: '2024-03-22',
      amount: 2213.94,
      dueDate: '2024-04-21',
      contactName: 'Mike Rivera',
      contactEmail: 'mike.r@techstack.io',
      contactPhone: '',
      paymentTerms: 'Net 30',
      poNumber: 'WI-2024-445',
    },
  },
  {
    id: 'ext-3',
    input: `from: billing@cloudnine.dev
subject: Your CloudNine Invoice #CN-00234

Hi team, attached is your monthly invoice.

Amount due: USD 8,750.25
Service period: Dec 1 - Dec 31, 2023
Invoice date: Jan 2, 2024
Payment due by: January 31, 2024

Questions? Reach out to Jamie Ortiz at jamie@cloudnine.dev or call (212) 555-8834.
Purchase order ref: STARTUP-2023-Q4
Payment: Net 30 from invoice date`,
    expectedOutput: {
      vendor: 'CloudNine',
      invoiceNumber: 'CN-00234',
      date: '2024-01-02',
      amount: 8750.25,
      dueDate: '2024-01-31',
      contactName: 'Jamie Ortiz',
      contactEmail: 'jamie@cloudnine.dev',
      contactPhone: '(212) 555-8834',
      paymentTerms: 'Net 30',
      poNumber: 'STARTUP-2023-Q4',
    },
  },
];

// --- Scenario 2: Support Ticket Classification ---

const classificationCases: TestCase[] = [
  {
    id: 'cls-1',
    input: `Subject: Can't login after password reset

I reset my password yesterday using the forgot password link, got the email,
set a new password. Now when I try to login it says "invalid credentials".
I've tried 3 times. I'm locked out of my account and I have a deadline today.
This is URGENT. Account email: jdoe@company.com`,
    expectedOutput: {
      category: 'authentication',
      priority: 'high',
      sentiment: 'frustrated',
      requiresEscalation: true,
      tags: ['login', 'password-reset', 'account-lockout'],
    },
  },
  {
    id: 'cls-2',
    input: `Hi, I was wondering if you offer volume discounts for teams over 50 users?
We're currently on the Pro plan with 23 seats and looking to expand.
Also interested in the Enterprise tier - could someone walk us through the
differences? We'd need SSO and audit logs. Thanks! - Maria, VP Eng at DataFlow`,
    expectedOutput: {
      category: 'sales',
      priority: 'medium',
      sentiment: 'positive',
      requiresEscalation: false,
      tags: ['pricing', 'enterprise', 'volume-discount', 'sso'],
    },
  },
  {
    id: 'cls-3',
    input: `The export to CSV feature is broken again. When I click "Export" on the
dashboard analytics page, it downloads a file but all the date columns show
"NaN" instead of actual dates. This was working fine last week.
Browser: Chrome 121 on Mac. Screenshot attached.`,
    expectedOutput: {
      category: 'bug',
      priority: 'medium',
      sentiment: 'neutral',
      requiresEscalation: false,
      tags: ['csv-export', 'data-formatting', 'regression', 'analytics'],
    },
  },
  {
    id: 'cls-4',
    input: `Just wanted to say the new dark mode is absolutely gorgeous! The team did
an amazing job. One small suggestion - could you add a way to schedule
auto-switching between light/dark based on time of day? Would be a nice
quality of life feature. Keep up the great work!`,
    expectedOutput: {
      category: 'feature-request',
      priority: 'low',
      sentiment: 'positive',
      requiresEscalation: false,
      tags: ['dark-mode', 'ui', 'scheduling', 'quality-of-life'],
    },
  },
  {
    id: 'cls-5',
    input: `CRITICAL: Our production database appears to be leaking data. I can see
other customers' records when I query the /api/users endpoint with certain
parameters. I have screenshots and reproduction steps. This is a security
issue and needs immediate attention. Do NOT deploy any more changes until
this is fixed. Contact: security@bigclient.com`,
    expectedOutput: {
      category: 'security',
      priority: 'critical',
      sentiment: 'urgent',
      requiresEscalation: true,
      tags: ['data-leak', 'security-vulnerability', 'api', 'production'],
    },
  },
];

// --- Scenario 3: Natural Language to SQL ---

const sqlCases: TestCase[] = [
  {
    id: 'sql-1',
    input: `Show me all customers who signed up in the last 30 days and have made at least one purchase.

Schema:
- customers (id, name, email, created_at)
- orders (id, customer_id, total, created_at)`,
    expectedOutput: {
      query: `SELECT DISTINCT c.id, c.name, c.email, c.created_at FROM customers c INNER JOIN orders o ON c.id = o.customer_id WHERE c.created_at >= NOW() - INTERVAL '30 days'`,
      tables: ['customers', 'orders'],
      joinType: 'inner',
      hasWhereClause: true,
      hasAggregation: false,
    },
  },
  {
    id: 'sql-2',
    input: `What are the top 5 products by revenue this quarter, including how many units were sold?

Schema:
- products (id, name, category, price)
- order_items (id, order_id, product_id, quantity, unit_price)
- orders (id, customer_id, total, created_at)`,
    expectedOutput: {
      query: `SELECT p.id, p.name, SUM(oi.quantity) AS units_sold, SUM(oi.quantity * oi.unit_price) AS revenue FROM products p INNER JOIN order_items oi ON p.id = oi.product_id INNER JOIN orders o ON oi.order_id = o.id WHERE o.created_at >= DATE_TRUNC('quarter', NOW()) GROUP BY p.id, p.name ORDER BY revenue DESC LIMIT 5`,
      tables: ['products', 'order_items', 'orders'],
      joinType: 'inner',
      hasWhereClause: true,
      hasAggregation: true,
    },
  },
  {
    id: 'sql-3',
    input: `Find customers who haven't placed any orders in the last 6 months but were active before that.

Schema:
- customers (id, name, email, created_at, last_active_at)
- orders (id, customer_id, total, created_at)`,
    expectedOutput: {
      query: `SELECT c.id, c.name, c.email FROM customers c WHERE c.last_active_at < NOW() - INTERVAL '6 months' AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at < NOW() - INTERVAL '6 months') AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at >= NOW() - INTERVAL '6 months')`,
      tables: ['customers', 'orders'],
      joinType: 'subquery',
      hasWhereClause: true,
      hasAggregation: false,
    },
  },
  {
    id: 'sql-4',
    input: `Calculate the month-over-month revenue growth rate for the last 12 months.

Schema:
- orders (id, customer_id, total, created_at)`,
    expectedOutput: {
      query: `WITH monthly AS (SELECT DATE_TRUNC('month', created_at) AS month, SUM(total) AS revenue FROM orders WHERE created_at >= NOW() - INTERVAL '12 months' GROUP BY DATE_TRUNC('month', created_at)) SELECT month, revenue, LAG(revenue) OVER (ORDER BY month) AS prev_revenue, ROUND((revenue - LAG(revenue) OVER (ORDER BY month)) / LAG(revenue) OVER (ORDER BY month) * 100, 2) AS growth_pct FROM monthly ORDER BY month`,
      tables: ['orders'],
      joinType: 'none',
      hasWhereClause: true,
      hasAggregation: true,
    },
  },
];

// --- Scoring functions ---

function scoreExtraction(output: string, expected: Record<string, unknown>): number {
  try {
    const parsed = JSON.parse(output);
    const fields = Object.keys(expected);
    let matches = 0;
    for (const field of fields) {
      const expectedVal = String(expected[field]).toLowerCase().trim();
      const actualVal = String(parsed[field] ?? '').toLowerCase().trim();
      if (!expectedVal && !actualVal) {
        matches++;
      } else if (expectedVal && actualVal.includes(expectedVal)) {
        matches++;
      } else if (actualVal && expectedVal.includes(actualVal)) {
        matches++;
      } else if (field === 'amount' || field === 'dueDate' || field === 'date') {
        // Numeric/date comparison - normalize
        const expNum = parseFloat(expectedVal.replace(/[^0-9.]/g, ''));
        const actNum = parseFloat(actualVal.replace(/[^0-9.]/g, ''));
        if (!isNaN(expNum) && !isNaN(actNum) && expNum === actNum) {
          matches++;
        }
      }
    }
    return matches / fields.length;
  } catch {
    return 0;
  }
}

function scoreClassification(output: string, expected: Record<string, unknown>): number {
  try {
    const parsed = JSON.parse(output);
    let score = 0;
    const weights = { category: 0.3, priority: 0.25, sentiment: 0.15, requiresEscalation: 0.15, tags: 0.15 };

    // Category match
    if (String(parsed.category).toLowerCase() === String(expected.category).toLowerCase()) {
      score += weights.category;
    }

    // Priority match
    if (String(parsed.priority).toLowerCase() === String(expected.priority).toLowerCase()) {
      score += weights.priority;
    }

    // Sentiment match
    const expSentiment = String(expected.sentiment).toLowerCase();
    const actSentiment = String(parsed.sentiment).toLowerCase();
    if (actSentiment === expSentiment) {
      score += weights.sentiment;
    } else if (
      (expSentiment === 'frustrated' && actSentiment === 'negative') ||
      (expSentiment === 'urgent' && (actSentiment === 'negative' || actSentiment === 'alarmed'))
    ) {
      score += weights.sentiment * 0.5;
    }

    // Escalation match
    if (Boolean(parsed.requiresEscalation) === Boolean(expected.requiresEscalation)) {
      score += weights.requiresEscalation;
    }

    // Tags overlap
    const expectedTags = (expected.tags as string[]).map(t => t.toLowerCase());
    const actualTags = (Array.isArray(parsed.tags) ? parsed.tags : []).map((t: string) => t.toLowerCase());
    if (expectedTags.length > 0) {
      const overlap = actualTags.filter((t: string) => expectedTags.some(et => t.includes(et) || et.includes(t))).length;
      score += weights.tags * Math.min(1, overlap / expectedTags.length);
    }

    return score;
  } catch {
    return 0;
  }
}

function scoreSql(output: string, expected: Record<string, unknown>): number {
  try {
    const parsed = JSON.parse(output);
    let score = 0;
    const weights = { tables: 0.25, joinType: 0.15, hasWhereClause: 0.15, hasAggregation: 0.15, syntaxValid: 0.3 };

    // Check tables used
    const expectedTables = (expected.tables as string[]).map(t => t.toLowerCase());
    const actualTables = (Array.isArray(parsed.tables) ? parsed.tables : []).map((t: string) => t.toLowerCase());
    const tableOverlap = actualTables.filter((t: string) => expectedTables.includes(t)).length;
    if (expectedTables.length > 0) {
      score += weights.tables * (tableOverlap / expectedTables.length);
    }

    // Check join type
    if (String(parsed.joinType).toLowerCase() === String(expected.joinType).toLowerCase()) {
      score += weights.joinType;
    }

    // Check where clause
    if (Boolean(parsed.hasWhereClause) === Boolean(expected.hasWhereClause)) {
      score += weights.hasWhereClause;
    }

    // Check aggregation
    if (Boolean(parsed.hasAggregation) === Boolean(expected.hasAggregation)) {
      score += weights.hasAggregation;
    }

    // Check SQL syntax validity (basic heuristic)
    const query = String(parsed.query || '').toUpperCase();
    if (query.includes('SELECT') && query.includes('FROM')) {
      score += weights.syntaxValid * 0.5;
      if (expected.hasAggregation && (query.includes('SUM') || query.includes('COUNT') || query.includes('AVG') || query.includes('GROUP BY'))) {
        score += weights.syntaxValid * 0.25;
      }
      if (expected.hasWhereClause && query.includes('WHERE')) {
        score += weights.syntaxValid * 0.25;
      }
      if (!expected.hasAggregation) {
        score += weights.syntaxValid * 0.25;
      }
      if (!expected.hasWhereClause) {
        score += weights.syntaxValid * 0.25;
      }
    }

    return Math.min(1, score);
  } catch {
    return 0;
  }
}

// --- Prompts ---

const extractionGeneralist = `You are a helpful AI assistant. The user will give you some text. Extract structured data from it and return valid JSON with relevant fields. Return ONLY the JSON object, no other text.`;

const extractionSpecialist = `You are an expert invoice data extraction agent. Your ONLY job is extracting structured data from invoice text.

Always return a JSON object with exactly these fields:
- vendor: string (company name)
- invoiceNumber: string
- date: string (ISO format YYYY-MM-DD)
- amount: number (total amount as float, no currency symbols)
- dueDate: string (ISO format YYYY-MM-DD)
- contactName: string (empty string if not found)
- contactEmail: string (empty string if not found)
- contactPhone: string (empty string if not found)
- paymentTerms: string (e.g. "Net 30")
- poNumber: string (purchase order number, empty string if not found)

Rules:
- Dates MUST be ISO format (YYYY-MM-DD)
- Amount must be a number, not a string
- If a field is missing, use empty string for strings, 0 for numbers
- Return ONLY the JSON object, no markdown, no explanation`;

const classificationGeneralist = `You are a helpful AI assistant. The user will give you a support ticket. Classify it and return valid JSON with the classification. Return ONLY the JSON object, no other text.`;

const classificationSpecialist = `You are an expert support ticket classifier. Your ONLY job is classifying customer support tickets.

Always return a JSON object with exactly these fields:
- category: one of "authentication", "bug", "feature-request", "sales", "security", "billing", "documentation", "general"
- priority: one of "critical", "high", "medium", "low"
- sentiment: one of "positive", "neutral", "frustrated", "urgent"
- requiresEscalation: boolean (true for security issues, data breaches, account lockouts with deadlines, legal threats)
- tags: string array of 2-5 relevant lowercase kebab-case tags

Priority rules:
- critical: security vulnerabilities, data leaks, production outages
- high: account lockouts, payment failures, deadline-sensitive issues
- medium: bugs, broken features, pricing inquiries
- low: feature requests, positive feedback, general questions

Return ONLY the JSON object, no markdown, no explanation`;

const sqlGeneralist = `You are a helpful AI assistant. The user will describe a data query in natural language along with a database schema. Write a SQL query and return a JSON object describing it. Return ONLY the JSON object, no other text.`;

const sqlSpecialist = `You are an expert SQL query generator. Your ONLY job is converting natural language questions into PostgreSQL queries.

Always return a JSON object with exactly these fields:
- query: string (the full PostgreSQL query, properly formatted)
- tables: string array (all tables referenced)
- joinType: one of "inner", "left", "right", "full", "cross", "subquery", "none"
- hasWhereClause: boolean
- hasAggregation: boolean (true if using GROUP BY, SUM, COUNT, AVG, etc.)

SQL rules:
- Use PostgreSQL syntax (INTERVAL, DATE_TRUNC, NOW(), etc.)
- Use CTEs (WITH) for complex queries
- Use window functions (LAG, LEAD, ROW_NUMBER) when appropriate
- Always alias calculated columns
- Use DISTINCT when joining might produce duplicates
- Prefer EXISTS/NOT EXISTS over IN for subqueries
- Format dates with DATE_TRUNC for grouping

Return ONLY the JSON object, no markdown, no explanation`;

const orchestratorPrompt = `You are an orchestrator agent. You receive tasks and decide which specialist to route them to.

You have access to these specialists:
1. "extraction" - Expert at extracting structured data from messy text (invoices, receipts, documents)
2. "classification" - Expert at classifying support tickets, emails, and customer communications
3. "sql" - Expert at converting natural language to SQL queries

Analyze the task and return a JSON object with:
- specialist: string (which specialist to route to: "extraction", "classification", or "sql")
- confidence: number (0-1, how confident you are in the routing)
- reasoning: string (one sentence explaining why)

Return ONLY the JSON object, no markdown, no explanation.`;

// --- Export scenarios ---

export const SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'extraction',
    name: 'Invoice Data Extraction',
    description: 'Extract structured fields from messy invoice text',
    generalistPrompt: extractionGeneralist,
    specialistPrompt: extractionSpecialist,
    orchestratorPrompt,
    testCases: extractionCases,
    scoreOutput: scoreExtraction,
  },
  {
    id: 'classification',
    name: 'Support Ticket Classification',
    description: 'Classify support tickets by category, priority, sentiment',
    generalistPrompt: classificationGeneralist,
    specialistPrompt: classificationSpecialist,
    orchestratorPrompt,
    testCases: classificationCases,
    scoreOutput: scoreClassification,
  },
  {
    id: 'sql',
    name: 'Natural Language to SQL',
    description: 'Convert plain English questions into PostgreSQL queries',
    generalistPrompt: sqlGeneralist,
    specialistPrompt: sqlSpecialist,
    orchestratorPrompt,
    testCases: sqlCases,
    scoreOutput: scoreSql,
  },
];

// Token cost estimation (Claude 3.5 Haiku pricing as baseline)
export const TOKEN_COSTS = {
  input: 0.80 / 1_000_000,   // $0.80 per 1M input tokens
  output: 4.00 / 1_000_000,  // $4.00 per 1M output tokens
  orchestratorOverhead: 0.15, // 15% overhead for orchestrator routing
};
