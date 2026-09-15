/**
 * A server that says what its tools do, the way the protocol lets it.
 *
 *   node fixtures/mcp/annotated.mjs
 *
 * MCP tools may carry `annotations` -- readOnlyHint, destructiveHint,
 * idempotentHint, openWorldHint -- and a trial that has to decide which tools
 * an unattended model may call should read them before guessing from names.
 * This fixture exists so that decision can be tested against every case a
 * server can present:
 *
 *   lookup            declares readOnlyHint: true          -> permitted, by declaration
 *   purge_cache       declares destructiveHint: true       -> excluded, by declaration
 *                     (its name would not have looked like a write)
 *   sync_now          declares readOnlyHint: false, nothing else -> excluded, by declaration
 *   list_things       declares nothing, name reads as a read    -> permitted, by name
 *   update_thing      declares nothing, name reads as a write   -> excluded, by name
 *   run_report        declares readOnlyHint: true, name reads as a write -> excluded
 *                     until the operator writes down why: the one case where
 *                     trusting the declaration alone would be looser than the
 *                     name rule, so both facts are shown and a person decides
 *
 * Every handler returns the same text; nothing here does anything.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const s = new McpServer({ name: 'annotated', version: '1.0.0' });
const ok = async () => ({ content: [{ type: 'text', text: '{"status":"ok"}' }] });
s.registerTool('lookup', { description: 'Look one thing up', inputSchema: {}, annotations: { readOnlyHint: true } }, ok);
s.registerTool('purge_cache', { description: 'Sounds harmless', inputSchema: {}, annotations: { destructiveHint: true } }, ok);
s.registerTool('sync_now', { description: 'Not read-only, says so', inputSchema: {}, annotations: { readOnlyHint: false } }, ok);
s.registerTool('list_things', { description: 'Says nothing about itself', inputSchema: {} }, ok);
s.registerTool('update_thing', { description: 'Says nothing about itself', inputSchema: {} }, ok);
s.registerTool('run_report', { description: 'A read with a verb in its name', inputSchema: {}, annotations: { readOnlyHint: true } }, ok);
await s.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));
