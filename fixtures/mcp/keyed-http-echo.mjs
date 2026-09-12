/**
 * An HTTP (Streamable HTTP) server behind a door: every request must carry
 * the right bearer token, or it is refused at the HTTP layer with a 401.
 *
 *   node fixtures/mcp/keyed-http-echo.mjs --port 0 --token-sha256 <hex of the expected token>
 *
 * The HTTP analogue of keyed-echo.mjs: the shape of a token-auth remote MCP
 * server (a PAT, an API key) whose credential rides in the `Authorization`
 * header. The token itself is never on the command line — only its SHA-256
 * is, which is what a real server checks against its store. It prints
 * `LISTENING <port>` on stderr once bound, so a caller can read the port.
 *
 * Two refusals, so a proof can tell them apart: no bearer token at all, and
 * a bearer token that does not match. Neither echoes what was presented.
 * `scripts/gateway-door.ts --http` is the proof.
 */
import http from 'http';
import crypto, { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const PORT = Number(arg('port', '0'));
const EXPECT = String(arg('token-sha256', '')).toLowerCase();
if (!/^[0-9a-f]{64}$/.test(EXPECT)) {
  process.stderr.write('keyed-http-echo: --token-sha256 <64 hex chars> is required\n');
  process.exit(2);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function build() {
  const s = new McpServer({ name: 'keyed-http-echo', version: '1.0.0' });
  s.registerTool(
    'open',
    {
      description: 'Echo a message back through the door. Reachable only with the right bearer token.',
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, opened: message }) }] }),
  );
  return s;
}

const refuse = (res, message) => {
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
};

const transports = new Map();
const server = http.createServer(async (req, res) => {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers['authorization'] ?? ''));
  if (!m) return refuse(res, 'unauthorized: no bearer token');
  if (sha256(m[1]) !== EXPECT) return refuse(res, 'unauthorized: bearer token does not match');
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
