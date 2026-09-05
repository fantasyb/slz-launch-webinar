/**
 * A server whose tool list changes while it is running, on request.
 *
 *   node fixtures/mcp/mutable.mjs --phase-file /tmp/phase
 *
 * Real servers do this: a connector adds a tool in a release, renames one,
 * tightens a schema, flips an annotation. The trial has to stop when that
 * happens under a run, and the gateway has to notice it and say so, and
 * neither can be tested against a server that stands still. This one reads a
 * word from the phase file every 300ms and moves when the word changes:
 *
 *   base         query_records (no annotation; object, filter, limit)
 *                get_record    (readOnlyHint: true; object, id)
 *   destructive  base, plus delete_records (destructiveHint: true)
 *   rename       query_records becomes search_records, same schema
 *   flip         get_record now declares readOnlyHint: false
 *   schema       query_records loses its `limit` argument
 *
 * Each move is the minimal set of register/update/remove calls, so the
 * notifications a client sees are the ones a real server would send. Moves
 * go from base to a phase and back; the file is written once per test.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

const at = process.argv.indexOf('--phase-file');
const PHASE_FILE = at !== -1 ? process.argv[at + 1] : null;

const s = new McpServer({ name: 'mutable', version: '1.0.0' });
const ok = async () => ({ content: [{ type: 'text', text: '{"status":"success","records":[]}' }] });
const QUERY_DESC = 'Query records of an object';
const FULL = { object: z.string(), filter: z.record(z.string()).optional(), limit: z.number().optional() };

const tools = {
  query: s.registerTool('query_records', { description: QUERY_DESC, inputSchema: FULL }, ok),
  get: s.registerTool('get_record', { description: 'Fetch one record', inputSchema: { object: z.string(), id: z.string() }, annotations: { readOnlyHint: true } }, ok),
  del: null,
  search: null,
};

let current = 'base';
function undo(phase) {
  if (phase === 'destructive') { tools.del?.remove(); tools.del = null; }
  if (phase === 'rename') { tools.search?.remove(); tools.search = null; tools.query = s.registerTool('query_records', { description: QUERY_DESC, inputSchema: FULL }, ok); }
  if (phase === 'flip') tools.get.update({ annotations: { readOnlyHint: true } });
  if (phase === 'schema') tools.query.update({ paramsSchema: FULL });
}
function apply(phase) {
  if (phase === 'destructive') tools.del = s.registerTool('delete_records', { description: 'Delete records', inputSchema: { object: z.string(), ids: z.array(z.string()) }, annotations: { destructiveHint: true } }, ok);
  if (phase === 'rename') { tools.query.remove(); tools.search = s.registerTool('search_records', { description: QUERY_DESC, inputSchema: FULL }, ok); }
  if (phase === 'flip') tools.get.update({ annotations: { readOnlyHint: false } });
  if (phase === 'schema') tools.query.update({ paramsSchema: { object: z.string(), filter: z.record(z.string()).optional() } });
}
function move(phase) {
  if (phase === current) return;
  if (current !== 'base') undo(current);
  if (phase !== 'base') apply(phase);
  current = phase;
}

await s.connect(new StdioServerTransport());
if (PHASE_FILE) {
  const read = () => { try { return fs.readFileSync(PHASE_FILE, 'utf8').trim() || 'base'; } catch { return 'base'; } };
  move(read());
  setInterval(() => { try { move(read()); } catch (e) { process.stderr.write(`mutable: ${e.message}\n`); } }, 300).unref();
}
process.stdin.on('end', () => process.exit(0));
