/** Hermetic setup probe: only fixture-named values; no ambient secrets returned. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'setup-fixture', version: '1' });
server.registerTool('inspect_setup', { description: 'Inspect explicit fixture configuration' }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), explicit: process.env.SETUP_TOKEN, allowed: process.env.SETUP_ALLOWED, ambient: !!process.env.AMBIENT_SECRET, control: !!process.env.CAIRN_KEY }) }] }));
await server.connect(new StdioServerTransport());
