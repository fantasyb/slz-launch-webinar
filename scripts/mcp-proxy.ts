/**
 * Cairn as a gateway: findings ride back on the results they are about.
 *
 *   node bin/cairn-proxy.js --server "npx -y @acme/their-mcp-server"
 *
 * Point your client at this instead of at the server it wraps. Every call is
 * forwarded untouched and every result comes back with, at most, one recorded
 * finding about the tool that produced it.
 *
 * WHY A RESULT AND NOT A HOOK. Push delivery is the binding constraint --
 * cairn-0035 measured that an agent which does not ask gets nothing, and a
 * weak model went 0/5 to 4/5 on the same corpus when findings were handed
 * over unasked. The two obvious channels each fail half the problem: MCP
 * tools are PULL, something the agent must decide to call, and a client hook
 * is real push that belongs to one vendor. A tool RESULT is the one piece of
 * text an agent always reads, in every client, with no feature to negotiate.
 * So the finding travels on the result: "this tool returns empty instead of
 * erroring" arrives attached to the empty result it is about.
 *
 * WHAT IT COSTS, said plainly rather than discovered later. It speaks AFTER
 * the call. For a trap in a tool's behaviour that is the right moment, and
 * it is the wrong moment for a call that changed something. Where a client
 * has hooks, use them for before-the-call warnings; this is the floor
 * underneath, not a replacement.
 *
 * NEVER A GATE. Every request is forwarded and every result is returned,
 * including when this file throws. A mechanism that can block a call is one
 * people switch off, and then it delivers nothing at all.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { preflight } from '../src/lib/cairn/retrieval';
import { loadSearchable, type SearchableFinding } from '../src/lib/cairn/federation';

const argv = process.argv.slice(2);
const at = argv.indexOf('--server');
if (at === -1 || !argv[at + 1]) {
  console.error('usage: cairn-proxy --server "<command to run the upstream MCP server>"');
  process.exit(2);
}
const [cmd, ...cmdArgs] = argv[at + 1].split(/\s+/);

/**
 * One finding, clipped, delimited, and labelled as not coming from the tool.
 *
 * The label is load-bearing rather than decorative. A model implicitly trusts
 * a tool result, and this appends text to one — so it has to be unmistakable
 * that the trailing block came from the user's own corpus and not from the
 * service that was called. Every push channel is prompt injection with a
 * trusted sender; the delimiter is what keeps the sender honest.
 */
function annotation(toolName: string): string | null {
  let warnings;
  try {
    warnings = preflight(toolName, loadSearchable().findings, { useLocalEnvironment: false });
  } catch {
    return null; /* Never let a corpus problem break somebody's tool call. */
  }
  /*
   * Upstream findings do not annotate results. A finding from a corpus
   * somebody else maintains, injected into a result the model trusts, is a
   * different trust decision from reading it in a search — and it is one the
   * org makes, not this file.
   */
  const local = warnings.filter((w) => !(w.finding as SearchableFinding).upstreamName);
  if (!local.length) return null;
  const f = local[0].finding;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return (
    `\n\n--- from your Cairn corpus, not from this tool ---\n` +
    `${f.id} — ${f.title}\n` +
    `WHAT HAPPENS: ${clip(f.reality, 400)}` +
    (f.workaround ? `\nINSTEAD: ${clip(f.workaround, 400)}` : '') +
    `\n--- end ---`
  );
}

async function main() {
  const upstream = new Client({ name: 'cairn-proxy', version: '0.1.0' }, { capabilities: {} });
  await upstream.connect(new StdioClientTransport({ command: cmd, args: cmdArgs }));

  const server = new Server(
    { name: 'cairn-proxy', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      /*
       * Delivered once at connect, so a client with no hooks and no habit of
       * searching still receives the instruction. This is the degrade-to-
       * something floor: without it, a client without hooks gets silence,
       * which is the failure this whole thing exists to fix.
       */
      instructions:
        'Traps recorded about these tools are appended to their results, marked as ' +
        'coming from your Cairn corpus rather than from the tool. When you lose time to ' +
        'behaviour that contradicted a reasonable expectation, record it with cairn_record ' +
        'once you have solved it.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await upstream.callTool(req.params);
    try {
      const note = annotation(req.params.name);
      if (note && Array.isArray(result.content)) {
        result.content = [...result.content, { type: 'text', text: note }];
      }
    } catch {
      /* The result is the user's; a failure here must never withhold it. */
    }
    return result;
  });

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(`cairn-proxy: ${(e as Error).message}`);
  process.exit(1);
});
