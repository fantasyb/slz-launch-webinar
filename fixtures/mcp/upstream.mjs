/**
 * A stand-in upstream MCP server for testing the proxy.
 *
 *   node fixtures/mcp/upstream.mjs [--name fake-data360]
 *
 * It reproduces the exact trap the fixture finding describes: a query that
 * returns an empty result with a SUCCESS status rather than an error, so a
 * caller cannot tell "no matching records" from "the mapping is broken". It
 * also offers a failing tool, a resource and a prompt, because a proxy that
 * forwards only tools BREAKS a server that offers more, and the test has to
 * be able to prove it does not.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

const at = process.argv.indexOf('--name');
const NAME = at !== -1 ? process.argv[at + 1] : 'fake-data360';
/*
 * --crash-marker <file>: the first call to `unrelated` exits the process
 * unless the file exists, and creates it on the way out. So the first
 * instance dies mid-call and a respawned one survives, which is the shape of
 * an upstream that fell over once.
 */
const cm = process.argv.indexOf('--crash-marker');
const CRASH_MARKER = cm !== -1 ? process.argv[cm + 1] : null;
/*
 * --refuse-start-unless <file>: exit at once unless the file exists. Combined
 * with --crash-marker this is an upstream that dies mid-call and then cannot
 * be restarted until something on the machine changes -- the shape of a
 * connector whose token expired and was refreshed a minute later.
 */
const rs = process.argv.indexOf('--refuse-start-unless');
if (rs !== -1 && !fs.existsSync(process.argv[rs + 1])) {
  process.stderr.write('upstream: refusing to start, marker absent\n');
  process.exit(1);
}
/* --slow-marker <file>: the `slow` tool waits four seconds, or writes the file and returns early when the call is cancelled. */
const sm = process.argv.indexOf('--slow-marker');
const SLOW_MARKER = sm !== -1 ? process.argv[sm + 1] : null;

const s = new McpServer(
  { name: NAME, version: '1.0.0' },
  { instructions: `upstream ${NAME} says: paginate with limit 50` },
);
s.registerTool(
  'mcp__data360__query_records',
  {
    description: 'Query records',
    inputSchema: { object: z.string(), mapping_id: z.string().optional().describe('The mapping to query through') },
  },
  async () => ({ content: [{ type: 'text', text: '{"status":"success","records":[]}' }] }),
);
s.registerTool(
  'mcp__data360__unrelated',
  { description: 'Something nothing is recorded about', inputSchema: {} },
  async () => {
    if (CRASH_MARKER && !fs.existsSync(CRASH_MARKER)) {
      fs.writeFileSync(CRASH_MARKER, 'crashed once');
      process.exit(1);
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  },
);
s.registerTool(
  'mcp__data360__slow',
  { description: 'A tool that takes a while, and notices being cancelled', inputSchema: {} },
  (_args, extra) =>
    new Promise((resolve) => {
      const done = setTimeout(() => resolve({ content: [{ type: 'text', text: 'finished' }] }), 4000);
      extra?.signal?.addEventListener('abort', () => {
        clearTimeout(done);
        if (SLOW_MARKER) fs.writeFileSync(SLOW_MARKER, 'cancelled');
        resolve({ content: [{ type: 'text', text: 'cancelled' }] });
      });
    }),
);
s.registerTool(
  'mcp__data360__failing',
  { description: 'A tool whose call fails', inputSchema: {} },
  async () => ({ isError: true, content: [{ type: 'text', text: 'UPSTREAM_FAILURE: mapping not found' }] }),
);
s.registerResource(
  'doc',
  'fixture://doc',
  { description: 'A document the upstream serves' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'resource body text from upstream' }] }),
);
s.registerPrompt(
  'greet',
  { description: 'A prompt the upstream serves', argsSchema: {} },
  () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'prompt body text from upstream' } }] }),
);
await s.connect(new StdioServerTransport());
/* A well-behaved stdio server exits when its client hangs up; the SDK's does not on its own. */
process.stdin.on('end', () => process.exit(0));
