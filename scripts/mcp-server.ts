/**
 * Cairn as an MCP server: bank and find from any client.
 *
 *   node bin/cairn-mcp.js          # stdio, as MCP clients expect
 *
 * The hooks are Claude Code's. This is the floor underneath them: any client
 * that speaks MCP gets `cairn_find` and `cairn_record` with no integration
 * work, which is what makes "bank that" mean something in Cursor, in
 * Agentforce, or in a client nobody has written yet.
 *
 * WHAT THIS DOES NOT SOLVE, said plainly because the distinction decides the
 * architecture: MCP is PULL. A tool is something an agent must decide to
 * call, and cairn-0035 is the measurement that agents do not decide to.
 * Push delivery -- a finding arriving because the agent reached for a tool,
 * without anyone asking -- needs a client-side hook and cannot be an MCP
 * server. So: MCP for universal reach, hooks for delivery where they exist.
 *
 * WHEN THIS ONE, AND WHEN THE GATEWAY. The gateway (mcp-proxy.ts) offers the
 * same two tools and delivers findings on the surfaces a decision is made
 * from, but it needs an upstream to wrap: it refuses to start with no
 * --server. An agent whose work is files and shell rather than MCP tools has
 * nothing to put it in front of, and this is the server for that case --
 * find and record, over stdio, with no upstream. Two differences are
 * deliberate: cairn_find here searches the federated corpus (loadSearchable),
 * where the gateway annotates from LOCAL findings only, because injecting a
 * stranger's finding into a result the model trusts is the org's decision and
 * not this file's; and cairn_brief exists here because a task description is
 * a thing an agent can offer before starting, which a gateway never sees.
 * Recording goes through recordSubmission(), the same door as the CLI and
 * the gateway, so the bar cannot differ by entrance.
 *
 * The tool DESCRIPTIONS carry the requirement rather than a document
 * carrying it. That is not a style choice: in the twelve-trial run, agents
 * given a tool whose description spelled out what a check must do wrote a
 * discriminating check four times in six, against four in nineteen across a
 * corpus written without that instruction.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { retrieve } from '../src/lib/cairn/retrieval';
import { loadSearchable, type SearchableFinding } from '../src/lib/cairn/federation';
import { brief } from '../src/lib/cairn/brief';
import { observe } from '../src/lib/cairn/observe';
import { recordSubmission } from '../src/lib/cairn/recordFinding';

const server = new McpServer({ name: 'cairn', version: '0.1.0' });

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

server.registerTool(
  'cairn_find',
  {
    description:
      'Search a ledger of recorded traps — things that do not work in this stack, and why. ' +
      'Use it two ways: paste an error you cannot explain, or describe what you are about to ' +
      'build before you build it. Silence means nothing is recorded about it, which is the ' +
      'common case; proceed. A match is not a verdict — judge whether it applies.',
    inputSchema: { query: z.string().min(1).describe('The error text, verbatim, or what you are about to do') },
  },
  async ({ query }) => {
    const searchable = loadSearchable();
    const hits = retrieve(query, searchable.findings, { limit: 5 });
    observe(query, hits, 'mcp:find');
    if (!hits.length) return text('Nothing recorded bears on that.');
    return text(
      hits
        .map((h) => {
          const f = h.finding as SearchableFinding;
          return (
            `${f.displayId ?? f.id} [${h.strength}] ${f.title}\n` +
            `  ACTUALLY: ${f.reality.slice(0, 400)}` +
            (f.workaround ? `\n  INSTEAD: ${f.workaround.slice(0, 400)}` : '') +
            (h.caveats.length ? `\n  CAVEAT: ${h.caveats.join('; ')}` : '')
          );
        })
        .join('\n\n'),
    );
  },
);

server.registerTool(
  'cairn_brief',
  {
    description:
      'Findings worth handing over before starting a task, strongest first. Empty for most ' +
      'tasks, which is intended rather than a failure to match.',
    inputSchema: { task: z.string().min(1).describe('What you are about to do') },
  },
  async ({ task }) => {
    const corpus = loadSearchable().findings;
    const out = brief(task, corpus, { useLocalEnvironment: true });
    observe(task, retrieve(task, corpus, { limit: 5 }), 'mcp:brief');
    return text(out || 'Nothing recorded bears on that. Proceed.');
  },
);

server.registerTool(
  'cairn_record',
  {
    description:
      'Record a trap you just hit, so the next agent does not lose the same time to it. Use it ' +
      'AFTER you have solved something that surprised you — not for your own mistakes, and not ' +
      'for errors you expected. The `check` must EXIT NON-ZERO when the trap is absent; a check ' +
      'that succeeds either way records nothing. If reproducing it needs a connector or a human, ' +
      'describe the check in prose and it will be marked manual. Set `tool` when the trap is an ' +
      "MCP tool's behaviour — that is what makes the finding come back the next time anyone " +
      'reaches for that tool.',
    inputSchema: {
      title: z.string().min(1).max(120),
      claim: z.string().min(40).max(2000).describe('One falsifiable sentence'),
      expectation: z.string().min(1).describe('What a competent person would reasonably predict'),
      reality: z.string().min(1).describe('What actually happens instead'),
      workaround: z.string().optional().describe('What to do instead'),
      tool: z.string().optional().describe('The MCP tool this is about, named exactly'),
      evidence: z
        .array(z.object({ command: z.string(), output: z.string() }))
        .min(1)
        .describe('The call you made and what it returned'),
      check: z.object({
        command: z.string(),
        confirmedIf: z.string(),
        refutedIf: z.string(),
        absentWhen: z.string().optional().describe('What makes the trap stop happening'),
      }),
      by: z.string().describe('Your model or agent identifier'),
    },
  },
  async (args) => {
    /*
     * The one write path, shared with the CLI and the gateway. `origin:
     * 'agent'`: whatever the machine's execution policy says, a check that
     * arrived through a tool call is never run -- see recordFinding.ts.
     */
    const outcome = await recordSubmission(args, { origin: 'agent' });
    return { isError: !outcome.ok, content: [{ type: 'text' as const, text: outcome.message }] };
  },
);

/*
 * Inside main(), because build-cli emits CJS and top-level await is not
 * available there. Third script in this repository to hit it -- record.ts and
 * gate.ts both shipped unable to run for the same reason -- and each time the
 * failure arrives as an esbuild error at bundle time rather than anywhere
 * near the await, so it reads as a broken toolchain.
 */
async function main() {
  await server.connect(new StdioServerTransport());
}

main();
