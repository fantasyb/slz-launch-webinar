/**
 * A server behind a door: its one tool works only when the process was
 * started with the right key in its environment.
 *
 *   node fixtures/mcp/keyed-echo.mjs --key-sha256 <hex of the expected DOOR_KEY>
 *
 * The shape of every API-backed MCP server: the credential arrives in `env`,
 * the server refuses without it. The key itself is never on the command line
 * (a process listing would show it) — only its SHA-256 is, which is what a
 * real server checks against its backend. The point of the fixture is the
 * PLACEMENT of the key, not the tool: when the gateway's `--config` is the
 * only file that holds it, calling this server straight is a call with no
 * key, and it fails. `scripts/gateway-door.ts` is the proof.
 *
 * It never prints the key, to stderr or in a result. A server that echoes
 * its own credential is a different bug and not the one under test.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'crypto';

const at = process.argv.indexOf('--key-sha256');
const EXPECT = at !== -1 ? String(process.argv[at + 1] ?? '').toLowerCase() : '';
if (!/^[0-9a-f]{64}$/.test(EXPECT)) {
  process.stderr.write('keyed-echo: --key-sha256 <64 hex chars> is required\n');
  process.exit(2);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const refuse = (message) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'error', message }) }] });

const s = new McpServer({ name: 'keyed-echo', version: '1.0.0' });
s.registerTool(
  'open',
  {
    description: 'Echo a message back through the door. Succeeds only when this server was started with the right DOOR_KEY.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => {
    const key = process.env.DOOR_KEY;
    if (!key) return refuse('DOOR_KEY is not set: this server was started without its key');
    if (sha256(key) !== EXPECT) return refuse('DOOR_KEY does not match the key this server expects');
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, opened: message }) }] };
  },
);
await s.connect(new StdioServerTransport());
