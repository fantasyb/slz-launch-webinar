/*
 * Does an agent reach for cairn when it needs it, and does that help?
 *
 * RUN 1 and RUN 2 used a LOUD trap: cairn-0003, ripgrep parsing `interface{}`
 * as a repetition quantifier. Both arms answered correctly in both runs. The
 * model reached for `grep -F`; when the task forbade grep it reached for
 * `rg -F`. Where the failure announces itself with a parse error and exit 2,
 * a capable model recovers on its own and the corpus adds nothing. That is a
 * real result and it is recorded, not discarded.
 *
 * This run uses a SILENT trap: cairn-0005. A Next.js App Router page that
 * calls `new Date()` is prerendered at build time, so the clock freezes at
 * whatever time the deploy ran. The build succeeds. The page renders. The
 * types check. Nothing fails until someone notices the timestamp is three
 * days old. There is no error to paste, so this also tests the harder thing:
 * whether an agent consults the ledger BEFORE it has a failure to look up.
 *
 * That is what the `triggers` field is for, and the tool description below
 * invites preflight use rather than only postmortem use. Changing the
 * affordance is part of what is being measured; the corpus text is untouched.
 *
 * Three trials per arm. A single trial per arm is the mistake this repo has
 * already made once and written down.
 */
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';

const FIXTURE =
  '/tmp/claude-0/-home-user-slz-launch-webinar/cd16b2bc-8949-542b-a8aa-9cadcf6e0c44/scratchpad/nextapp';
const TRIALS = 3;
const corpus = loadCorpus();

/*
 * Nothing here hints that a trap exists. It is the request a colleague would
 * make, in a repo whose README already says App Router and Vercel.
 */
const TASK =
  'This is a Next.js App Router project. Add a page at app/now/page.tsx that shows ' +
  'the current server time and today\'s date, and link to it from the home page. ' +
  'Write the files with a heredoc. When you are done, say DONE.';

const bashTool = {
  name: 'bash',
  description: 'Run a shell command in the project directory and return its output and exit code.',
  input_schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
};
const cairnTool = {
  name: 'cairn_search',
  description:
    'Search a ledger of recorded engineering traps — things that do not work in this stack, ' +
    'and why. Use it two ways: paste an error you cannot explain, or describe what you are ' +
    'about to build before you build it, to find out what has already bitten someone here. ' +
    'Returns findings with a confidence and a caveat when the match is weak.',
  input_schema: { type: 'object' as const, properties: { query: { type: 'string' } }, required: ['query'] },
};

function runBash(cmd: string, cwd: string): string {
  try {
    const out = execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 });
    return `exit 0\n${out.slice(0, 3000)}`;
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return `exit ${err.status ?? '?'}\n${err.stdout ?? ''}${err.stderr ?? ''}`.slice(0, 3000);
  }
}
function runCairn(q: string): string {
  const hits = retrieve(q, corpus, { useLocalEnvironment: true, limit: 3 });
  if (!hits.length) return 'Nothing in the ledger matches that.';
  return hits
    .map(
      (h) =>
        `${h.finding.id} [${h.strength}] ${h.finding.title}\n  ACTUALLY: ${h.finding.reality.slice(0, 300)}` +
        (h.finding.workaround ? `\n  WORKAROUND: ${h.finding.workaround.slice(0, 300)}` : '') +
        (h.caveats.length ? `\n  CAVEAT: ${h.caveats.join('; ')}` : ''),
    )
    .join('\n\n');
}

/* The fix, in any of the forms Next.js accepts for it. */
function isFixed(src: string): boolean {
  return (
    /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(src) ||
    /export\s+const\s+revalidate\s*=\s*0\b/.test(src) ||
    /unstable_noStore|noStore\s*\(\s*\)|connection\s*\(\s*\)/.test(src)
  );
}

async function run(withCairn: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'now-'));
  cpSync(FIXTURE, dir, { recursive: true });
  const client = new Anthropic();
  const tools = withCairn ? [bashTool, cairnTool] : [bashTool];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: TASK }];
  const calls: string[] = [];
  let askedCairn = false;
  for (let turn = 0; turn < 14; turn++) {
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const inp = u.input as { command?: string; query?: string };
      if (u.name === 'bash') {
        calls.push(`bash: ${inp.command}`);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: runBash(inp.command ?? '', dir) });
      } else {
        askedCairn = true;
        calls.push(`CAIRN: ${inp.query}`);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: runCairn(inp.query ?? '') });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  const page = join(dir, 'app/now/page.tsx');
  const src = existsSync(page) ? readFileSync(page, 'utf8') : '';
  return { calls, askedCairn, wrote: src.length > 0, fixed: isFixed(src), src };
}

async function main() {
  const tally: Record<string, number[]> = { control: [], cairn: [] };
  for (const withCairn of [false, true]) {
    const key = withCairn ? 'cairn' : 'control';
    for (let t = 0; t < TRIALS; t++) {
      const r = await run(withCairn);
      tally[key].push(r.fixed ? 1 : 0);
      console.log(`\n${'='.repeat(72)}`);
      console.log(`${withCairn ? 'WITH CAIRN' : 'CONTROL (bash only)'}  trial ${t + 1}`);
      console.log('='.repeat(72));
      for (const c of r.calls) console.log(`  ${c.replace(/\s+/g, ' ').slice(0, 118)}`);
      console.log(
        `\n  wrote page: ${r.wrote}   asked cairn: ${r.askedCairn}   ` +
          `time is live: ${r.fixed ? 'YES' : 'NO — frozen at build'}`,
      );
      const decl = r.src.split('\n').filter((l) => /^export const/.test(l));
      if (decl.length) console.log(`  route config: ${decl.join(' | ')}`);
    }
  }
  const pct = (a: number[]) => `${a.reduce((x, y) => x + y, 0)}/${a.length}`;
  console.log(`\n\n  live clock — control ${pct(tally.control)}   with cairn ${pct(tally.cairn)}\n`);
}
void main();
