/**
 * A server whose tool list is PAGINATED, and whose second page fails on request.
 *
 *   node fixtures/mcp/paged.mjs --page2-marker <file>
 *
 * Page 1 offers `first`; page 2 offers `second`. While the marker file is
 * absent, the request for page 2 errors — the shape of a connector whose
 * listing is flaky or rate-limited mid-pagination. Once the marker exists the
 * listing completes. This is what a test needs to prove the gateway's
 * unknown-tool negative cache does not remember a tool as "unknown" merely
 * because the listing that should have shown it never finished: `second` is a
 * real tool the whole time, just on a page the gateway could not read.
 *
 * Built on the low-level Server (not McpServer) because the high-level API
 * owns tools/list and offers no way to paginate or fail a page.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';

const at = process.argv.indexOf('--page2-marker');
const MARKER = at !== -1 ? process.argv[at + 1] : null;

const s = new Server({ name: 'paged', version: '1.0.0' }, { capabilities: { tools: {} } });
const tool = (name) => ({ name, description: `Tool ${name}`, inputSchema: { type: 'object', properties: {} } });

s.setRequestHandler(ListToolsRequestSchema, async (req) => {
  if (!req.params?.cursor) return { tools: [tool('first')], nextCursor: 'page2' };
  if (MARKER && !fs.existsSync(MARKER)) throw new Error('page 2 is temporarily unavailable');
  return { tools: [tool('second')] };
});
s.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: 'text', text: `${req.params.name} called` }] }));

await s.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));
