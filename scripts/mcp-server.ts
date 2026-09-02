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
import { SubmissionSchema, normalise, likelyDuplicates, readsAsProse } from '../src/lib/cairn/submission';
import { FindingSchema } from '../src/lib/cairn/schema';
import { checkFlaws } from '../src/lib/cairn/checkquality';
import { scanExecutable, scanInjection, scanSensitive, draftSurface } from '../src/lib/cairn/safety';
import { cairnHome, homePath } from '../src/lib/cairn/home';
import { slugify } from '../src/lib/cairn/submission';
import fs from 'fs';
import path from 'path';

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
    const parsed = SubmissionSchema.safeParse(args);
    if (!parsed.success) {
      return text(
        `Not recordable yet:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
      );
    }
    const data = parsed.data;

    /* The same gates as the CLI and the HTTP endpoint. Two ways in with two
     * bars is how a corpus ends up with a clean half and a dirty half. */
    const flags = [
      ...scanExecutable(draftSurface(data as unknown as Record<string, unknown>)),
      ...scanInjection(draftSurface(data as unknown as Record<string, unknown>)),
      ...scanSensitive(draftSurface(data as unknown as Record<string, unknown>)),
    ];
    if (flags.length) {
      return text(
        `Refused — this must not be committed:\n${flags.map((f) => `  ${f.pattern}: ${f.reason}`).join('\n')}`,
      );
    }

    const flaws = checkFlaws({ ...data.check, manual: data.check.manual ?? readsAsProse(data.check.command) });
    if (flaws.length) {
      return text(
        `Refused — the check cannot decide whether this is happening:\n` +
          flaws.map((f) => `  ${f.rule}: ${f.detail}`).join('\n') +
          '\n\nMake it exit non-zero when the trap is ABSENT, or describe it in prose to mark it manual.',
      );
    }

    const dupes = likelyDuplicates(data.title, loadSearchable().findings);
    if (dupes.length) {
      return text(
        `Already recorded — add an observation to the existing finding instead:\n` +
          dupes.map((d) => `  ${d.id}  ${d.title}`).join('\n'),
      );
    }

    const dir = homePath('cairn');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const max = loadSearchable()
      .findings.filter((f) => !(f as SearchableFinding).upstreamName)
      .reduce((m, f) => Math.max(m, parseInt(f.id.slice(6), 10) || 0), 0);
    const num = String(max + 1).padStart(4, '0');
    const checked = FindingSchema.safeParse(normalise(data, new Date(), `cairn-${num}`).finding);
    if (!checked.success) return text('The finding did not validate after normalisation.');

    const file = path.join(dir, `${num}-${slugify(data.title)}.json`);
    if (fs.existsSync(file)) return text(`${file} already exists; nothing was written.`);
    fs.writeFileSync(file, `${JSON.stringify(checked.data, null, 2)}\n`);
    return text(
      `Recorded ${checked.data.id} in ${cairnHome()}.\n` +
        (data.tool
          ? `It will be handed over the next time anyone reaches for ${data.tool}.`
          : 'Set `tool` next time if this is about an MCP tool — that is what makes it come back.') +
        '\nUnsigned, so it counts as one environment and cannot raise scope on its own.',
    );
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
