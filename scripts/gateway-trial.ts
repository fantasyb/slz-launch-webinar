/**
 * cairn:gateway-trial — does an agent working THROUGH the gateway do better?
 *
 *   npm run cairn:gateway-trial -- --scenario all --arm all --trials 5 --model haiku
 *   npm run cairn:gateway-trial -- --smoke          # one trial per cell, reported as such
 *
 * The client is Claude Code itself, in -p mode, over real stdio — not an SDK
 * loop written here. Every earlier trial in this repository drove the model
 * through a hand-written tool loop; this one drives the harness people
 * actually run, with its own tool-loading behaviour (deferred MCP tools
 * behind ToolSearch), its own permission model, and its own transcript
 * format. What reaches the model is what that client chose to send it, and
 * the transcript is the client's record, not the proxy's.
 *
 * THREE ARMS, identical prompt, identical upstream, identical model:
 *
 *   control   the client talks to fixtures/mcp/records.mjs directly
 *   empty     the client talks to the gateway wrapping it, with NO findings
 *   gateway   the client talks to the gateway wrapping it, with two findings
 *             about query_records (fixtures/trials/gateway/corpus)
 *
 * `empty` exists so that "the gateway helped" cannot be "the proxy changed
 * something else": if empty differs from control, the proxy is doing more
 * than annotating.
 *
 * WHAT THE INSTRUMENT MUST NOT DO, each one checked rather than assumed:
 *
 *   - Write to this repository's ledger. Each gateway trial gets its own
 *     CAIRN_HOME under the OS temp dir; the proxy's ledger rows are copied
 *     into the run record from there. `git status` after a run is the test.
 *   - Let the child see this repository's CLAUDE.md, which tells agents to
 *     consult Cairn. The trial cwd is outside the repo and the env vars that
 *     import additional CLAUDE.md directories are removed. Probed before this
 *     was written: a scrubbed child answered NO to "do your instructions
 *     mention Cairn".
 *   - Let the child read the fixture source, where the trap is spelled out.
 *     No file or shell tools are allowed; permission denials are recorded and
 *     a trial with any denial is flagged.
 *   - Compute the truth through the tools it is grading. truth() reads the
 *     arrays.
 *   - Decide correctness from delivery. Whether an annotation arrived is
 *     recorded from the client's transcript (a tool_result carrying the
 *     proxy's label) and reported beside correctness, never folded into it.
 *   - Run against a stale bundle. The trial refuses if dist/cli/mcp-proxy.js
 *     is older than any source it was built from.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const RECORDS = path.join(REPO, 'fixtures', 'mcp', 'records.mjs');
const CORPUS = path.join(REPO, 'fixtures', 'trials', 'gateway', 'corpus');
const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js');
const BUNDLE = path.join(REPO, 'dist', 'cli', 'mcp-proxy.js');
const LABEL = 'from your Cairn corpus, not from this tool';

type Arm = 'control' | 'empty' | 'gateway';
const ARMS: Arm[] = ['control', 'empty', 'gateway'];

interface Scenario {
  name: string;
  key: 'churned' | 'open_tier2';
  prompt: string;
}
const SCENARIOS: Scenario[] = [
  {
    name: 'A-silent-cap',
    key: 'churned',
    prompt:
      'You have access to a records API through MCP tools. Question: how many Contact records have status "churned"? ' +
      'Use the tools to find out. When you are done, reply with only a JSON object of the form {"churned": <number>} and nothing else.',
  },
  {
    name: 'B-stale-mapping',
    key: 'open_tier2',
    prompt:
      'You have access to a records API through MCP tools. Question: how many Case records have status "open" and queue "Tier2"? ' +
      'Use the tools to find out. When you are done, reply with only a JSON object of the form {"open_tier2": <number>} and nothing else.',
  },
];

/* ---- arguments ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const SMOKE = argv.includes('--smoke');
const TRIALS = SMOKE ? 1 : Number(opt('trials', '5'));
const MODEL = opt('model', 'haiku');
const wantScenario = opt('scenario', 'all');
const wantArm = opt('arm', 'all');
const MAX_TURNS = Number(opt('max-turns', '40'));
const RUN_ID = `${SMOKE ? 'smoke' : 'run'}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${MODEL}`;
const OUT_DIR = path.join(REPO, 'data', 'gateway-trials');
const OUT = path.join(OUT_DIR, `${RUN_ID}.json`);

/* ---- stale bundle guard ------------------------------------------------- */

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}
if (!fs.existsSync(BUNDLE)) {
  console.error('refusing: dist/cli/mcp-proxy.js is not built. Run npm run cairn:build-cli first.');
  process.exit(2);
}
const bundleAt = fs.statSync(BUNDLE).mtimeMs;
const sourceAt = Math.max(newestMtime(path.join(REPO, 'src')), newestMtime(path.join(REPO, 'scripts')));
if (sourceAt > bundleAt) {
  console.error('refusing: dist/cli/mcp-proxy.js is older than the source. Run npm run cairn:build-cli first.');
  process.exit(2);
}

/* ---- one trial ---------------------------------------------------------- */

interface Trial {
  scenario: string;
  arm: Arm;
  trial: number;
  sessionId: string;
  answer: number | null;
  truth: number;
  correct: boolean;
  turns: number;
  toolCalls: Record<string, number>;
  mcpCalls: number;
  costUsd: number;
  durationMs: number;
  denials: unknown[];
  /** From the CLIENT's transcript: tool_result blocks that carried the proxy's label. */
  delivered: { onResult: number; onToolSearch: number };
  /** From the proxy's own ledger in the trial's CAIRN_HOME: what it says it served. */
  proxyLedger: Record<string, number>;
  usedIncludePaging: boolean;
  usedExplicitMapping: boolean;
  resultText: string;
  stderrTail: string;
  error?: string;
}

async function runTrial(sc: Scenario, arm: Arm, n: number, truthValue: number): Promise<Trial> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-gw-${arm}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-gw-home-`));
  fs.mkdirSync(path.join(home, 'cairn'));
  if (arm === 'gateway') {
    for (const f of fs.readdirSync(path.join(CORPUS, 'cairn'))) {
      fs.copyFileSync(path.join(CORPUS, 'cairn', f), path.join(home, 'cairn', f));
    }
  }
  const mcp =
    arm === 'control'
      ? { mcpServers: { records: { command: 'node', args: [RECORDS] } } }
      : {
          mcpServers: {
            records: {
              command: 'node',
              args: [PROXY_BIN, '--server', `node ${RECORDS}`],
              env: { CAIRN_HOME: home, CAIRN_AGENT: `trial-${arm}`, CAIRN_SESSION: `trial-${sc.name}-${arm}-${n}` },
            },
          },
        };
  const cfg = path.join(work, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify(mcp));
  const sessionId = randomUUID();

  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_ADDITIONAL_DIRECTORIES', 'CLAUDE_CODE_CHILD_SESSION', 'CAIRN_HOME', 'CAIRN_EVAL']) {
    delete env[k];
  }

  const args = [
    '-p', sc.prompt,
    '--model', MODEL,
    '--session-id', sessionId,
    '--no-session-persistence',
    '--mcp-config', cfg,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__records',
    '--disallowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit,Skill',
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'stream-json',
    '--verbose',
  ];
  const started = Date.now();
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn('claude', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    child.on('close', (c) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code: c }); });
  });
  const durationMs = Date.now() - started;

  const toolCalls: Record<string, number> = {};
  let delivered = { onResult: 0, onToolSearch: 0 };
  let usedIncludePaging = false;
  let usedExplicitMapping = false;
  let result: Record<string, unknown> | null = null;
  const useIds = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev: { type?: string; message?: { content?: unknown[] }; [k: string]: unknown };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') { result = ev; continue; }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        const name = String(block.name);
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        useIds.set(String(block.id), name);
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (name.endsWith('query_records')) {
          if (input.include_paging === true) usedIncludePaging = true;
          if (typeof input.mapping_id === 'string') usedExplicitMapping = true;
        }
      }
      if (block.type === 'tool_result') {
        const text = JSON.stringify(block.content ?? '');
        if (text.includes(LABEL)) {
          const via = useIds.get(String(block.tool_use_id)) ?? '';
          if (via === 'ToolSearch') delivered.onToolSearch++;
          else delivered.onResult++;
        }
      }
    }
  }
  const mcpCalls = Object.entries(toolCalls).filter(([k]) => k.startsWith('mcp__records__')).reduce((a, [, v]) => a + v, 0);

  const resultText = String(result?.result ?? '');
  let answer: number | null = null;
  const m = resultText.match(/\{[^{}]*\}/g);
  if (m) {
    for (const cand of m.reverse()) {
      try {
        const j = JSON.parse(cand) as Record<string, unknown>;
        if (typeof j[sc.key] === 'number') { answer = j[sc.key] as number; break; }
      } catch { /* next */ }
    }
  }

  const proxyLedger: Record<string, number> = {};
  const ledgerDir = path.join(home, 'data', 'retrievals');
  if (fs.existsSync(ledgerDir)) {
    for (const f of fs.readdirSync(ledgerDir)) {
      for (const l of fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(l) as { source?: string };
          const s = r.source ?? '?';
          proxyLedger[s] = (proxyLedger[s] ?? 0) + 1;
        } catch { /* skip */ }
      }
    }
  }

  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });

  return {
    scenario: sc.name, arm, trial: n, sessionId,
    answer, truth: truthValue, correct: answer === truthValue,
    turns: Number(result?.num_turns ?? 0),
    toolCalls, mcpCalls,
    costUsd: Number(result?.total_cost_usd ?? 0),
    durationMs,
    denials: (result?.permission_denials as unknown[]) ?? [],
    delivered, proxyLedger, usedIncludePaging, usedExplicitMapping,
    resultText: resultText.slice(0, 400),
    stderrTail: stderr.slice(-600),
    error: code !== 0 ? `claude exited ${code}` : result ? undefined : 'no result event',
  };
}

/* ---- main --------------------------------------------------------------- */

async function main() {
  const records = await import(RECORDS);
  const truth = records.truth() as { churned: number; open_tier2: number };
  const scenarios = SCENARIOS.filter((s) => wantScenario === 'all' || s.name.startsWith(wantScenario));
  const arms = ARMS.filter((a) => wantArm === 'all' || a === wantArm);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const trials: Trial[] = [];
  const save = () =>
    fs.writeFileSync(OUT, `${JSON.stringify({ runId: RUN_ID, smoke: SMOKE, model: MODEL, trialsPerCell: TRIALS, truth, startedAt, bundleAt: new Date(bundleAt).toISOString(), trials }, null, 2)}\n`);
  const startedAt = new Date().toISOString();

  console.log(`\nGATEWAY TRIAL ${RUN_ID} — model ${MODEL}, ${TRIALS} per cell, truth ${JSON.stringify(truth)}\n`);
  for (const sc of scenarios) {
    for (let n = 1; n <= TRIALS; n++) {
      /* Interleave arms within a trial index so a slow hour or a model
       * hiccup lands on every arm equally rather than on whichever ran last. */
      for (const arm of arms) {
        const t = await runTrial(sc, arm, n, truth[sc.key]);
        trials.push(t);
        save();
        console.log(
          `  ${sc.name.padEnd(16)} ${arm.padEnd(8)} #${n}  ${t.correct ? 'CORRECT' : 'wrong  '}  answer=${t.answer ?? '-'} truth=${t.truth}` +
            `  mcp=${t.mcpCalls} turns=${t.turns} $${t.costUsd.toFixed(3)} ${(t.durationMs / 1000).toFixed(0)}s` +
            `  delivered=${t.delivered.onResult}/${t.delivered.onToolSearch}` +
            (t.denials.length ? `  DENIALS=${t.denials.length}` : '') +
            (t.error ? `  ERROR=${t.error}` : ''),
        );
      }
    }
  }

  console.log('\nSUMMARY (correct / trials)');
  for (const sc of scenarios) {
    const row = arms.map((arm) => {
      const ts = trials.filter((t) => t.scenario === sc.name && t.arm === arm);
      const ok = ts.filter((t) => t.correct).length;
      const calls = ts.reduce((a, t) => a + t.mcpCalls, 0) / Math.max(1, ts.length);
      return `${arm} ${ok}/${ts.length} (mcp calls avg ${calls.toFixed(1)})`;
    });
    console.log(`  ${sc.name.padEnd(16)} ${row.join('   ')}`);
  }
  console.log(`\nwritten: ${path.relative(REPO, OUT)}`);
  const bad = trials.filter((t) => t.denials.length || t.error);
  if (bad.length) console.log(`\n${bad.length} trial(s) had denials or errors — read them before trusting the summary.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
