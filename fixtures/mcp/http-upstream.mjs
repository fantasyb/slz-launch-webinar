/**
 * A stand-in HTTP (Streamable HTTP) upstream MCP server, for testing that the
 * proxy can wrap a URL server, not just a spawned stdio one.
 *
 *   node fixtures/mcp/http-upstream.mjs --port 0 [--name records] [--token SECRET]
 *
 * It prints `LISTENING <port>` on stderr once bound (so a test can read the
 * chosen port), offers the same success-shaped `query_records` trap as the
 * stdio fixture, and — when --token is given — refuses any request whose
 * Authorization header is not `Bearer <token>`, so a test can prove the proxy
 * forwards the auth header from the wrapped config.
 */
import http from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const NAME = arg('name', 'records');
const PORT = Number(arg('port', '0'));
const TOKEN = arg('token', null);

function build() {
  const s = new McpServer({ name: NAME, version: '1.0.0' }, { instructions: `http upstream ${NAME}` });
  s.registerTool(
    'mcp__data360__query_records',
    { description: 'Query records', inputSchema: { object: z.string(), mapping_id: z.string().optional() } },
    async () => ({ content: [{ type: 'text', text: '{"status":"success","records":[]}' }] }),
  );
  return s;
}

const transports = new Map();

const server = http.createServer(async (req, res) => {
  // Auth gate: when a token is configured, every request must carry it. This is
  // what proves the proxy forwarded the header from the wrapped server's config.
  if (TOKEN && req.headers['authorization'] !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }));
    return;
  }
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
  }
  const sid = req.headers['mcp-session-id'];
  const existing = typeof sid === 'string' ? transports.get(sid) : undefined;
  if (existing) return void existing.handleRequest(req, res, body);
  if (req.method === 'POST' && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
      onsessionclosed: (id) => transports.delete(id),
    });
    transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
    await build().connect(transport);
    return void transport.handleRequest(req, res, body);
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no session; send initialize first' }, id: null }));
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  process.stderr.write(`LISTENING ${typeof addr === 'object' && addr ? addr.port : PORT}\n`);
});
process.stdin.on('end', () => process.exit(0));
