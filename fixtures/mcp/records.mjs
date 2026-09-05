/**
 * A records API with the traps that actually bite, as an MCP server.
 *
 *   node fixtures/mcp/records.mjs
 *
 * Every earlier fixture in this repository was built to exercise the proxy's
 * plumbing. This one is built to exercise an AGENT: a small CRM-shaped API
 * whose tools behave the way the ones in BANK.md do — success-shaped answers
 * that are wrong. Nothing here errors. That is the point: an error is a
 * signal, and these traps have none.
 *
 *   T1  query_records returns at most 50 rows whatever `limit` says, and the
 *       response carries no total and no next-page token, so fifty rows read
 *       as the whole set. Paging exists, but only when `include_paging: true`
 *       is passed, which the schema does not mention.
 *
 *   T2  query_records on Case goes through the object's default mapping,
 *       which is stale, and a stale mapping returns `{"status":"success",
 *       "records":[]}`. Zero is a legitimate answer to a count question, so
 *       nothing prompts a second look. A fresher mapping is listed by
 *       list_mappings and works when named explicitly.
 *
 * The data is deterministic, generated from a fixed seed, and `truth()` is
 * computed from the arrays directly — never through the tools — so the
 * grader cannot inherit a trap from the thing it grades.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';

/* ---- deterministic data ------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const REGIONS = ['emea', 'amer-east', 'amer-west', 'apac', 'latam', 'anz'];
const PLANS = ['starter', 'team', 'enterprise'];
const FIRST = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Ida', 'Jo', 'Kai', 'Lu', 'Mo', 'Nia', 'Oz', 'Pia', 'Quin', 'Rae', 'Sol', 'Tam', 'Uma'];
const LAST = ['Okoro', 'Lind', 'Sato', 'Reyes', 'Novak', 'Haas', 'Idris', 'Moreau', 'Chen', 'Duff'];

export function buildData(seed = 20260902) {
  const rnd = mulberry32(seed);
  /* Contacts: 300, of which exactly 137 churned. Regions shuffled so no
   * single region holds 50+ churned contacts: the honest expensive route
   * around T1 (partition by region) has to remain possible. */
  const statuses = shuffle(
    [...Array(137).fill('churned'), ...Array(100).fill('active'), ...Array(40).fill('trial'), ...Array(23).fill('paused')],
    rnd,
  );
  const contacts = statuses.map((status, i) => ({
    id: `003${String(100000 + i).padStart(6, '0')}`,
    name: `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`,
    email: `user${i}@example.test`,
    status,
    region: REGIONS[i % REGIONS.length],
    plan: PLANS[Math.floor(rnd() * PLANS.length)],
  }));
  /* Cases: 48 in total so T1 never interferes with T2. Open+Tier2 is exactly 29. */
  const caseShape = shuffle(
    [
      ...Array(29).fill(['open', 'Tier2']), ...Array(7).fill(['open', 'Tier1']), ...Array(4).fill(['open', 'Tier3']),
      ...Array(5).fill(['closed', 'Tier2']), ...Array(3).fill(['closed', 'Tier1']),
    ],
    rnd,
  );
  const cases = caseShape.map(([status, queue], i) => ({
    id: `500${String(200000 + i).padStart(6, '0')}`,
    subject: `Case ${i}: ${['login', 'billing', 'export', 'sync'][i % 4]} issue`,
    status,
    queue,
    priority: ['low', 'medium', 'high'][Math.floor(rnd() * 3)],
    contact_id: contacts[Math.floor(rnd() * contacts.length)].id,
  }));
  return { contacts, cases };
}

/** Computed from the arrays, never through a tool. */
export function truth(data = buildData()) {
  return {
    churned: data.contacts.filter((c) => c.status === 'churned').length,
    open_tier2: data.cases.filter((c) => c.status === 'open' && c.queue === 'Tier2').length,
  };
}

const MAPPINGS = [
  { id: 'mp_contacts_v1', object: 'Contact', status: 'active', refreshed_at: '2026-08-30T02:00:00Z' },
  { id: 'mp_cases_v1', object: 'Case', status: 'active', refreshed_at: '2026-05-14T02:00:00Z' },
  { id: 'mp_cases_v2', object: 'Case', status: 'active', refreshed_at: '2026-09-01T02:00:00Z' },
];
const DEFAULT_MAPPING = { Contact: 'mp_contacts_v1', Case: 'mp_cases_v1' };
const STALE = new Set(['mp_cases_v1']);
const HARD_CAP = 50;

const FIELDS = {
  Contact: ['id', 'name', 'email', 'status', 'region', 'plan'],
  Case: ['id', 'subject', 'status', 'queue', 'priority', 'contact_id'],
  Account: ['id', 'name', 'tier'],
};

/* ---- the server -------------------------------------------------------- */

export function serve(data = buildData()) {
  const rows = { Contact: data.contacts, Case: data.cases, Account: [] };
  const s = new McpServer({ name: 'records', version: '1.0.0' });
  const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: msg }) }] });

  s.registerTool('list_objects', { description: 'List the objects available to query.', inputSchema: {} }, async () =>
    json({ objects: Object.keys(FIELDS) }),
  );
  s.registerTool(
    'describe_object',
    { description: 'Describe the fields of an object.', inputSchema: { object: z.string() } },
    async ({ object }) => (FIELDS[object] ? json({ object, fields: FIELDS[object] }) : fail(`unknown object ${object}`)),
  );
  s.registerTool(
    'list_mappings',
    {
      description: 'List the data mappings records are queried through. Optionally filter by object.',
      inputSchema: { object: z.string().optional() },
    },
    async ({ object }) => json({ mappings: MAPPINGS.filter((m) => !object || m.object === object) }),
  );
  s.registerTool(
    'query_records',
    {
      description:
        'Query records of an object through a mapping. Returns matching records. ' +
        'Use `filter` for equality conditions on fields, e.g. {"status": "active"}.',
      /*
       * A full zod object with passthrough, not a raw shape: the SDK wraps a
       * shape in z.object(), which STRIPS unknown keys before the handler
       * runs, so the undocumented `include_paging` never arrived and the
       * finding's workaround was impossible. The first smoke run found it.
       * Real servers accept what their docs do not list; this one now does.
       */
      inputSchema: z
        .object({
          object: z.string().describe('The object to query, e.g. Contact'),
          filter: z.record(z.string()).optional().describe('Equality filter, field -> value'),
          limit: z.number().int().optional().describe('Maximum rows to return (1-1000, default 100)'),
          mapping_id: z.string().optional().describe("The mapping to query through. Defaults to the object's default mapping."),
          page_token: z.string().optional().describe('Opaque token from a previous response to fetch the next page'),
        })
        .passthrough(),
    },
    async (args) => {
      const { object, filter, limit, mapping_id, page_token } = args;
      if (!rows[object]) return fail(`unknown object ${object}`);
      const mapping = mapping_id ?? DEFAULT_MAPPING[object];
      const m = MAPPINGS.find((x) => x.id === mapping);
      if (!m || m.object !== object) return fail(`mapping ${mapping} does not exist for ${object}`);
      /* T2: a stale mapping is a success with nothing in it. */
      if (STALE.has(mapping)) return json({ status: 'success', mapping_id: mapping, records: [] });
      let out = rows[object];
      if (filter) {
        for (const [k, v] of Object.entries(filter)) {
          if (!FIELDS[object].includes(k)) return fail(`unknown field ${k} on ${object}`);
          out = out.filter((r) => String(r[k]) === String(v));
        }
      }
      let offset = 0;
      if (page_token) {
        const parsed = Number(Buffer.from(String(page_token), 'base64').toString('utf8').replace(/^off:/, ''));
        if (!Number.isFinite(parsed)) return fail('invalid page_token');
        offset = parsed;
      }
      /* T1: the cap is silent and `limit` above it is ignored without comment. */
      const size = Math.min(Math.max(1, Number(limit) || 100), HARD_CAP);
      const page = out.slice(offset, offset + size);
      const body = { status: 'success', mapping_id: mapping, records: page };
      /* Paging exists, behind a flag the schema does not mention. */
      /* Boolean or the string "true": an argument the schema does not list
       * has no type, and the second smoke run showed the model sending the
       * string. A server that only honoured the boolean would be a second
       * trap stacked on the first, which is not the one being measured. */
      const paging = args.include_paging === true || args.include_paging === 'true';
      if (paging && offset + size < out.length) {
        body.next_page_token = Buffer.from(`off:${offset + size}`).toString('base64');
      }
      return json(body);
    },
  );
  s.registerTool(
    'get_record',
    { description: 'Fetch one record by id.', inputSchema: { object: z.string(), id: z.string() } },
    async ({ object, id }) => {
      const r = (rows[object] ?? []).find((x) => x.id === id);
      return r ? json({ status: 'success', record: r }) : fail(`no ${object} with id ${id}`);
    },
  );
  return s;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const s = serve();
  await s.connect(new StdioServerTransport());
  process.stdin.on('end', () => process.exit(0));
}
