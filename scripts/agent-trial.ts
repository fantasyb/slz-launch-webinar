/*
 * Does an agent reach for cairn when it needs it, and does that help?
 *
 * Two arms, identical but for the tool belt, on a task where the corpus knows
 * something. The agent is never told a trap exists, never told what the ledger
 * contains, and never told the answer.
 *
 * THREE SCENARIOS HAVE RUN. The first two found nothing, and both are kept
 * here because the pattern in them turned out to be the actual result.
 *
 *   braces (cairn-0003, LOUD, public knowledge)
 *     ripgrep parses `interface{}` as a repetition quantifier, exits 2.
 *     Both arms correct, twice. The model reached for `grep -F`; told to use
 *     ripgrep, it reached for `rg -F`. A failure that announces itself with a
 *     parse error and a nonzero exit gets recovered from unaided.
 *
 *   clock (cairn-0005, SILENT, public knowledge)
 *     An App Router page whose `new Date()` freezes at build time. Build
 *     passes, page renders, types check, and nothing is wrong until someone
 *     reads a stale timestamp. Designed to remove the loud-error crutch.
 *     Control 3/3, cairn 3/3. The cairn arm asked unprompted every time, got
 *     cairn-0005 ranked first, and cited it by id in a code comment -- and it
 *     changed nothing, because `force-dynamic` is in the Next.js docs and
 *     therefore in the model's weights.
 *
 * Two failed experiments with one cause: silence was never the variable.
 * PUBLICITY is. A finding earns its place only if the model cannot already
 * know it. cairn-0003 and cairn-0005 are public. So the third scenario uses a
 * trap that cannot be in any training set, because it is a property of this
 * sandbox: cairn-0001, where an allowlist proxy's CONNECT 403 arrives as a
 * transport error, `%{remote_ip}` is 127.0.0.1 because the local proxy
 * answered, and the agent reports an outage that is not happening.
 *
 *   reachability (cairn-0001, SILENT, environment-specific)
 *     The wrong answer here is not a crash. It is a confident sentence to the
 *     user -- "api.stripe.com is down" -- about a service that is up.
 *
 * Three trials per arm. One trial per arm is the mistake this repo has already
 * made once and recorded.
 */
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';

const SCRATCH =
  '/tmp/claude-0/-home-user-slz-launch-webinar/cd16b2bc-8949-542b-a8aa-9cadcf6e0c44/scratchpad';
const TRIALS = 5;
const corpus = loadCorpus();

interface Scenario {
  fixture?: string;
  task: string;
  /* Reads the trial's artefacts and says whether the trap was avoided. */
  verdict(dir: string, answer: string): { ok: boolean; detail: string };
  /* Set instead when the deliverable is prose and must be graded by a model. */
  judge?: string;
}

export const SCENARIOS: Record<string, Scenario> = {
  clock: {
    fixture: `${SCRATCH}/nextapp`,
    task:
      'This is a Next.js App Router project. Add a page at app/now/page.tsx that shows ' +
      "the current server time and today's date, and link to it from the home page. " +
      'Write the files with a heredoc. When you are done, say DONE.',
    verdict(dir) {
      const page = join(dir, 'app/now/page.tsx');
      const src = existsSync(page) ? readFileSync(page, 'utf8') : '';
      const ok =
        /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(src) ||
        /export\s+const\s+revalidate\s*=\s*0\b/.test(src) ||
        /unstable_noStore|noStore\s*\(\s*\)|connection\s*\(\s*\)/.test(src);
      /*
       * The detail must name the thing the verdict turned on. Listing only the
       * `export const` lines printed "no route config" beside ok=true for a page
       * that opts out with connection(), which is a report contradicting its own
       * result -- the failure mode this repo keeps rediscovering.
       */
      const how =
        src.split('\n').filter((l) => /^export const (dynamic|revalidate)/.test(l)).join(' | ') ||
        (/unstable_noStore|noStore\s*\(\s*\)/.test(src) ? 'noStore()' : '') ||
        (/connection\s*\(\s*\)/.test(src) ? 'connection()' : '');
      return { ok, detail: how || (src ? 'no opt-out of static rendering' : 'no page written') };
    },
  },

  reachability: {
    /*
     * The first version of this task asked whether a named payment API was
     * down. Every control trial came back stop_reason 'refusal' with zero
     * content blocks -- asking an agent to assess a third party's production
     * health reads as probing someone else's infrastructure. The treatment arm
     * was not refused, so the baseline silently zeroed and the run looked like
     * a result. Same trap, neutral host, our own pipeline.
     */
    task:
      'A nightly job on this machine fetches https://example.com/index.html and it started ' +
      'failing. Work out why and tell me plainly whether the remote host is up or down, so ' +
      'I know whether the problem is on our side or theirs.',
    /*
     * There is no artefact to grade -- the deliverable is a sentence, and the
     * failure is that the sentence is confidently false. Graded on the claim
     * the agent actually makes, then printed in full so the classification can
     * be checked by eye rather than trusted.
     */
    /*
     * Graded by a separate model call, not a regex. The first grader keyed on
     * the substring "<host> is down" and marked every correct answer wrong,
     * because a reply that opens "I cannot tell you whether the host is down"
     * contains it. Prose does not survive pattern matching; the judge sees the
     * reply with no knowledge of which arm produced it, and the full answer is
     * printed so its call can be checked by eye rather than trusted.
     */
    verdict() {
      return { ok: false, detail: 'judged separately' };
    },
    judge:
      'A colleague asked whether a remote host their nightly job fetches is up or down. ' +
      'Below is the reply they got. Classify what the reply CONCLUDES, ignoring hedging ' +
      'and ignoring how it is worded.\n\n' +
      'BLOCKED — it concludes the request never left the local machine (an egress proxy, ' +
      'allowlist, or local policy denied it), so the failure is local. This is the label ' +
      'even if the reply also says the remote host is fine, or says it cannot determine ' +
      'the remote host\'s health.\n' +
      'DOWN — it concludes the remote host itself is down, unreachable, or probably down.\n' +
      'NEITHER — it reaches no conclusion either way.\n\n' +
      'Reply with the label, then a dash and at most twelve words saying why.',
  },

  /*
   * FOURTH SCENARIO. The first three each failed for the same reason and the
   * reason is now cairn-0034: a finding pays only when BOTH routes around it
   * are shut. Braces and clock were public. Reachability was sandbox-only --
   * route one shut -- and the control arm still derived it locally, from a TLS
   * certificate whose issuer names the egress gateway.
   *
   * So this one shuts route two by construction. cairn-0019: a rule that reads
   * a value from the party it constrains does not constrain them. halfLifeDays
   * is declared by the author of the very claim it ages, so an author who does
   * not want their finding to look stale writes a large number and the rule
   * agrees with them. There is nothing on the machine to derive that from. The
   * script runs. The ranking is plausible. Every test an agent might write
   * passes. The defect is a property of who supplies the input, and the input
   * looks the same either way.
   *
   * Graded mechanically, not by a judge: after the agent finishes, a finding is
   * added that was last verified three years ago and declares a half-life of a
   * century. Any urgency measure that does not simply trust the field puts it
   * near the top. One that trusts it puts it last.
   */
  staleness: {
    fixture: `${SCRATCH}/ledger`,
    task:
      'This is a shared findings ledger — see README.md for the format. Findings go stale, ' +
      'and nobody re-checks them until something breaks. Write rank.mjs (plain node, no ' +
      'dependencies) that ranks the active findings by how urgently each one needs ' +
      're-verifying, so an agent with time for three of them does the right three. Each ' +
      'finding declares halfLifeDays. Print one finding id per line, most urgent first, and ' +
      'nothing else on those lines. Run it to show it works.',
    verdict(dir) {
      const script = join(dir, 'rank.mjs');
      if (!existsSync(script)) return { ok: false, detail: 'no rank.mjs written' };
      const order = (): string[] => {
        try {
          const out = execFileSync('node', ['rank.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
          return out.split('\n').map((l) => (l.match(/\bf-\d{4}\b/) ?? [''])[0]).filter(Boolean);
        } catch {
          return [];
        }
      };
      if (!order().length) return { ok: false, detail: 'rank.mjs produced no parseable ranking' };

      /*
       * The adversarial record. Three years unverified -- by a wide margin the
       * most overdue thing in the ledger -- and a half-life its own author set
       * to a century. Nothing else about it is unusual.
       */
      const stale = new Date(Date.now() - 3 * 365 * 86400_000).toISOString().slice(0, 10);
      writeFileSync(
        join(dir, 'findings/f-0099.json'),
        `${JSON.stringify(
          { id: 'f-0099', title: 'The vendor webhook retries with the same idempotency key',
            author: 'agent-rey', createdAt: '2023-01-04', lastVerifiedAt: stale,
            halfLifeDays: 36500, status: 'active' }, null, 2)}\n`,
      );
      const after = order();
      if (!after.length) return { ok: false, detail: 'rank.mjs failed once f-0099 existed' };
      const rank = after.indexOf('f-0099');
      if (rank < 0) return { ok: false, detail: `f-0099 absent from the ranking of ${after.length}` };
      return { ok: rank < 3, detail: `f-0099 ranked ${rank + 1} of ${after.length}` };
    },
  },
};

const bashTool = {
  name: 'bash',
  description: 'Run a shell command in the working directory and return its output and exit code.',
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
    const out = execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20 });
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

async function run(scenario: Scenario, withCairn: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'trial-'));
  if (scenario.fixture) cpSync(scenario.fixture, dir, { recursive: true });
  const client = new Anthropic();
  const tools = withCairn ? [bashTool, cairnTool] : [bashTool];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: scenario.task }];
  const calls: string[] = [];
  let askedCairn = false;
  let answer = '';
  for (let turn = 0; turn < 14; turn++) {
    const res = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      tools,
      messages,
    });
    /*
     * stop_reason 'refusal' comes back with zero content blocks and zero
     * output tokens. A loop that only asks "were there tool_use blocks?"
     * treats that as a completed turn and records an empty answer as data.
     * It zeroed a whole control arm here before anyone noticed.
     */
    if (res.stop_reason === 'refusal') {
      rmSync(dir, { recursive: true, force: true });
      return { calls, askedCairn, answer: '', refused: true, ok: false, detail: 'refused' };
    }
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) {
      answer = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      break;
    }
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
  if (scenario.judge) {
    const verdict = await judge(client, scenario.judge, answer);
    rmSync(dir, { recursive: true, force: true });
    return { calls, askedCairn, answer, refused: false, ok: verdict.startsWith('BLOCKED'), detail: verdict };
  }
  /*
   * Each trial gets a fresh copy and nothing ever deleted it. Three runs of the
   * same scenario left twenty-two directories in /tmp, which read as a harness
   * creating far more trials than it reported and cost two investigations
   * before the arithmetic explained it. Grade first, then remove.
   */
  const graded = { calls, askedCairn, answer, refused: false, ...scenario.verdict(dir, answer) };
  rmSync(dir, { recursive: true, force: true });
  return graded;
}

/* Sees the reply only. It is not told which arm produced it, or that arms exist. */
async function judge(client: Anthropic, rubric: string, answer: string): Promise<string> {
  if (!answer.trim()) return 'NEITHER';
  const res = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: `${rubric}\n\n--- reply ---\n${answer.slice(0, 8000)}` }],
  });
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  const label = (text.trim().toUpperCase().match(/BLOCKED|DOWN|NEITHER/) ?? ['NEITHER'])[0];
  return `${label} — ${text.replace(/\s+/g, ' ').replace(/^\W*\w+\W*[-—]?\s*/, '').slice(0, 90)}`;
}

async function main() {
  const name = process.argv[2] ?? 'reachability';
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`unknown scenario "${name}" — one of: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const tally: Record<string, number[]> = { control: [], cairn: [] };
  const refusals: Record<string, number> = { control: 0, cairn: 0 };
  const transcript: unknown[] = [];
  for (const withCairn of [false, true]) {
    for (let t = 0; t < TRIALS; t++) {
      const r = await run(scenario, withCairn);
      if (r.refused) refusals[withCairn ? 'cairn' : 'control']++;
      else tally[withCairn ? 'cairn' : 'control'].push(r.ok ? 1 : 0);
      console.log(`\n${'='.repeat(72)}`);
      console.log(`${name}  ·  ${withCairn ? 'WITH CAIRN' : 'CONTROL (bash only)'}  ·  trial ${t + 1}`);
      console.log('='.repeat(72));
      for (const c of r.calls) console.log(`  ${c.replace(/\s+/g, ' ').slice(0, 118)}`);
      console.log(`\n  asked cairn: ${r.askedCairn}   avoided the trap: ${r.ok ? 'YES' : 'NO'}   [${r.detail}]`);
      if (r.answer) console.log(`  answer: ${r.answer.replace(/\s+/g, ' ').slice(0, 700)}`);
      transcript.push({ arm: withCairn ? 'cairn' : 'control', trial: t + 1, ...r });
    }
  }
  const pct = (a: number[]) => (a.length ? `${a.reduce((x, y) => x + y, 0)}/${a.length}` : 'no data');
  console.log(`\n\n  ${name} — control ${pct(tally.control)}   with cairn ${pct(tally.cairn)}`);
  if (refusals.control || refusals.cairn)
    console.log(`  REFUSED (not counted) — control ${refusals.control}, cairn ${refusals.cairn}`);
  console.log();
  const out = join(tmpdir(), `agent-trial-${name}.json`);
  writeFileSync(out, JSON.stringify(transcript, null, 2));
  console.log(`  full answers: ${out}\n`);
}
/* Guarded so the grader can be imported and tested without launching a run. */
if (/agent-trial\.ts$/.test(process.argv[1] ?? '')) void main();
