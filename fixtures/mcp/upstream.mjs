/**
 * A stand-in upstream MCP server for testing the proxy.
 *
 * It reproduces the exact trap the fixture finding describes: a query that
 * returns an empty result with a SUCCESS status rather than an error, so a
 * caller cannot tell "no matching records" from "the mapping is broken".
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const s = new McpServer({ name: 'fake-data360', version: '1.0.0' });
s.registerTool(
  'mcp__data360__query_records',
  { description: 'Query records', inputSchema: { object: z.string() } },
  async () => ({ content: [{ type: 'text', text: '{"status":"success","records":[]}' }] }),
);
s.registerTool(
  'mcp__data360__unrelated',
  { description: 'Something nothing is recorded about', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'ok' }] }),
);
await s.connect(new StdioServerTransport());
