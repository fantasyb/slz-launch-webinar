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
import { recordNote } from '../src/lib/cairn/notes';
import { attest } from '../src/lib/cairn/attest';

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
      title: z.string().min(1).max(120).describe('One line, what does not work. At most 120 characters.'),
      claim: z.string().min(40).max(2000).describe('One falsifiable sentence, 40 to 2000 characters'),
      expectation: z.string().min(1).max(2000).describe('What a competent person would reasonably predict. Up to 2000 characters.'),
      reality: z.string().min(1).max(4000).describe('What actually happens instead. Up to 4000 characters.'),
      workaround: z.string().max(4000).optional().describe('What to do instead. Up to 4000 characters.'),
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
      distinctFrom: z
        .array(z.object({ id: z.string(), because: z.string().min(20).max(500) }))
        .max(3)
        .optional()
        .describe(
          'Only when a near-duplicate refusal named findings that are NOT your trap: one entry per id, with `because` saying what makes yours different. The refusal prints the exact value to send.',
        ),
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

/* The second tier, the same as the gateway offers: see src/lib/cairn/notes.ts. */
server.registerTool(
  'cairn_note',
  {
    description:
      'When there is no time for a finding: note what just did not work, in one call, with what you already have — ' +
      'the tool, the exact command and its output, the fix if any. Kept as a draft outside the corpus: not searchable, ' +
      'not delivered, not published, until you finish it with cairn_record. Dropped after 14 days.',
    inputSchema: {
      title: z.string().min(1).max(120).describe('One line, what did not work. At most 120 characters.'),
      tool: z.string().min(2).max(120).describe('The MCP tool this is about, named exactly'),
      evidence: z.array(z.object({ command: z.string(), output: z.string() })).min(1).max(20),
      workaround: z.string().max(4000).optional(),
      by: z.string().describe('Your model or agent identifier'),
    },
  },
  async (args) => {
    const outcome = recordNote(args, { origin: 'agent' } as never);
    return { isError: !outcome.ok, content: [{ type: 'text' as const, text: outcome.message }] };
  },
);

/* Observations from the agent that just used the tool: see src/lib/cairn/attest.ts. */
server.registerTool(
  'cairn_observe',
  {
    description:
      'After a tool call showed whether a recorded trap still holds: say so. confirmed if it bit as described, ' +
      'refuted if the call did what the finding says it cannot, inconclusive if you could not tell.',
    inputSchema: {
      finding: z.string().regex(/^cairn-\d{4}$/),
      verdict: z.enum(['confirmed', 'refuted', 'inconclusive']),
      note: z.string().max(4000).optional().describe('What the call returned. Required for refuted and inconclusive.'),
      by: z.string().describe('Your model or agent identifier'),
    },
  },
  async (args) => {
    const outcome = attest(args, { via: 'cairn mcp server' });
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
