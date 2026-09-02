/**
 * cairn:gateway-trial — does an agent working THROUGH the gateway do better?
 *
 *   CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- ~/pilot/trial.json
 *   CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- ~/pilot/trial.json --smoke
 *   CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- --regrade <run.json> ~/pilot/trial.json
 *
 * The client is Claude Code itself, in -p mode, over real stdio — not an SDK
 * loop written here. What reaches the model is what that client chose to
 * send it, and the transcript is the client's record, not the proxy's.
 *
 * THREE ARMS, identical prompt, identical upstream, identical model:
 *
 *   control   the client talks to the upstream directly
 *   empty     the client talks to the gateway wrapping it, with NO findings
 *   gateway   the client talks to the gateway wrapping it, with the findings
 *             in $CAIRN_HOME/cairn
 *
 * `empty` exists so that "the gateway helped" cannot be "the proxy changed
 * something else": if empty differs from control, the proxy is doing more
 * than annotating.
 *
 * EVERYTHING THAT VARIES COMES FROM OUTSIDE THIS FILE. The first version
 * hard-coded the fixture, the questions, the truth (computed from the
 * fixture's own arrays) and a grader that knew the fixture's argument names.
 * It could measure exactly one server. Now the upstream, the tool allowlist,
 * the scenarios, the truth and the forecast are a JSON file the operator
 * writes and commits, and the corpus is whatever is in $CAIRN_HOME/cairn.
 *
 * THIS IS POINTED AT PRODUCTION, so the instrument refuses rather than
 * assumes. Each refusal below is a thing that would have hurt on the first
 * real run, and each is checked before a single model call is made:
 *
 *   - No server-wide tool permission. The old harness passed
 *     `--allowedTools mcp__records`, which pre-approves every tool the
 *     server offers, writes included. The scenario file names each tool the
 *     agent may call; nothing else is permitted, and a name that reads as a
 *     write (create/update/delete/upsert/execute/...) is refused unless the
 *     operator states in the file why it is not one. The names are checked
 *     against the upstream's own tools/list before anything runs.
 *   - CAIRN_HOME must be set explicitly and resolve outside this repository.
 *     The corpus under test, the run record and the transcripts all live
 *     there; nothing from a run against a real server lands in a tracked
 *     directory of this checkout.
 *   - The execution policy for that corpus must be off. The gateway never
 *     executes an agent's check anyway (origin: 'agent'), but a trial is not
 *     the place to find out a policy file was misread.
 *   - The forecast must be sealed: the scenario file, forecast included, is
 *     committed and clean in a git repository before the run, and the run
 *     record names that commit. A forecast written after the numbers is not
 *     a forecast.
 *   - Transcripts are the raw session against production. They are redacted
 *     line by line before they touch disk, written under $CAIRN_HOME, and the
 *     directory carries its own .gitignore.
 *   - A stale dist/ bundle is refused, because it has hidden three fixes.
 *
 * WHAT THE INSTRUMENT MUST NOT DO, each one checked rather than assumed:
 *
 *   - Write to the operator's corpus. Each proxy trial gets its own CAIRN_HOME
 *     under the OS temp dir, seeded from $CAIRN_HOME/cairn and discarded; the
 *     proxy's ledger rows are copied into the run record from there.
 *   - Let the child see this repository's CLAUDE.md, which tells agents to
 *     consult Cairn. The trial cwd is outside the repo and the env vars that
 *     import additional CLAUDE.md directories are removed.
 *   - Let the child read files or run shell. No file or shell tools are
 *     allowed; permission denials are recorded and a trial with any denial is
 *     flagged.
 *   - Compute the truth through the tools it is grading. Truth is a number
 *     the operator wrote into the scenario file, obtained some other way.
 *   - Decide correctness from delivery. Whether an annotation arrived is
 *     recorded from the client's transcript (a tool_result carrying the
 *     proxy's label) and reported beside correctness, never folded into it.
 *
 * WHAT IT CANNOT FIX, and records instead: the operator who writes the
 * findings usually also writes the scenarios, and then knows the traps. The
 * run record carries who wrote each, and `independent` is true only when
 * they differ. A number from a run where they are the same person is the
 * author marking their own work, and the record says so in those words.
 */
import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { redactForLedger } from '../src/lib/cairn/safety';
import { executionPolicy, policyPath } from '../src/lib/cairn/policy';
import { FindingSchema } from '../src/lib/cairn/schema';

const REPO = process.cwd();
const PROXY_BIN = path.join(REPO, 'bin', 'cairn-proxy.js');
const BUNDLE = path.join(REPO, 'dist', 'cli', 'mcp-proxy.js');
const LABEL = 'from your Cairn corpus, not from this tool';

type Arm = 'control' | 'empty' | 'gateway';
const ARMS: Arm[] = ['control', 'empty', 'gateway'];

/* ---- the scenario file --------------------------------------------------- */

const ForecastSchema = z.object({
  control: z.number().int().min(0),
  empty: z.number().int().min(0),
  gateway: z.number().int().min(0),
  reasoning: z.string().min(20, 'say why, specifically; this is the part worth having'),
});

const ScenarioSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, . _ - only: it becomes a filename'),
  prompt: z.string().min(20),
  /** The key the agent is told to reply with: {"<key>": <answer>}. */
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  /** Obtained OUTSIDE the agent — a count run by hand, a report, a query in another tool. */
  truth: z.union([z.number(), z.string()]),
  /** For numeric truth: |answer - truth| <= tolerance still counts. Default exact. */
  tolerance: z.number().min(0).default(0),
  forecast: ForecastSchema,
});

const ServerSchema = z.object({
  /** The client's name for the server; tools become mcp__<name>__<tool>. */
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Non-secret settings only. Credentials come from the environment you run this in. */
  env: z.record(z.string()).default({}),
});

const TrialFileSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/),
  server: ServerSchema,
  /** Wire names of the tools the agent may call. Nothing else is permitted. */
  allowedTools: z.array(z.string().min(1)).min(1, 'name every tool the agent may call; there is no server-wide permission'),
  /** A name that reads as a write, and why it is not one. Unlisted write-looking names are refused. */
  readOnlyDespiteName: z.record(z.string().min(10)).default({}),
  /** Who chose the questions and the truths. Compared with who wrote the findings. */
  scenariosBy: z.string().min(1),
  scenarios: z.array(ScenarioSchema).min(1),
  model: z.string().default('haiku'),
  trials: z.number().int().min(1).max(20).default(5),
  maxTurns: z.number().int().min(1).max(200).default(40),
});
type TrialFile = z.infer<typeof TrialFileSchema>;
type Scenario = z.infer<typeof ScenarioSchema>;

const WRITE_LOOKING = /create|update|delete|upsert|execute|insert|remove|write|modify|destroy|drop|send|post|put|patch|deploy|run/i;

/* ---- arguments ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const SMOKE = argv.includes('--smoke');
const NO_TRANSCRIPTS = argv.includes('--no-transcripts');
const REGRADE_AT = argv.indexOf('--regrade');
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--regrade' && argv[i - 1] !== '--out');
const outAt = argv.indexOf('--out');

function refuse(what: string, how = ''): never {
  console.error(`\nREFUSED — ${what}\n${how ? `\n${how}\n` : ''}`);
  process.exit(2);
}

const trialFileArg = positional[0];
if (!trialFileArg) {
  refuse(
    'no scenario file',
    '  usage: CAIRN_HOME=<corpus> npm run cairn:gateway-trial -- <trial.json> [--smoke] [--no-transcripts] [--out <dir>]\n' +
      '         CAIRN_HOME=<corpus> npm run cairn:gateway-trial -- --regrade <run.json> <trial.json>\n' +
      '  The scenario file format is in GATEWAY.md under "Running the trial against your server".',
  );
}
const TRIAL_FILE = path.resolve(trialFileArg);

/* ---- refusals, in the order they are cheapest ---------------------------- */

const inside = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/* 1. CAIRN_HOME: set, outside this checkout, and a corpus. */
const HOME_RAW = process.env.CAIRN_HOME;
if (!HOME_RAW) {
  refuse(
    'CAIRN_HOME is not set',
    '  The corpus under test, the run record and the transcripts all go there, and it must be\n' +
      '  a directory outside this repository: nothing from a run against a real server may land\n' +
      '  in a tracked directory of this checkout.\n\n' +
      '    mkdir -p ~/pilot/cairn && CAIRN_HOME=~/pilot npm run cairn:gateway-trial -- ~/pilot/trial.json',
  );
}
const HOME = path.resolve(HOME_RAW);
if (inside(HOME, REPO)) {
  refuse(`CAIRN_HOME resolves inside this repository (${HOME})`, '  Point it at a directory outside the checkout, e.g. ~/pilot.');
}
if (!fs.existsSync(path.join(HOME, 'cairn'))) {
  refuse(`${HOME} has no cairn/ directory`, `  mkdir -p ${path.join(HOME, 'cairn')} and put the findings for the gateway arm in it.`);
}

/* 2. Execution policy off for that corpus. */
{
  const policy = executionPolicy();
  if (policy.enabled) {
    refuse(
      `execution is ENABLED for ${HOME} in ${policyPath()}`,
      '  A trial against a real server runs with checks off. Remove that corpus from the policy\n' +
        '  file, or set "enabled": false for it, and run again.',
    );
  }
}

/* 3. The scenario file: shape, then seal. */
if (!fs.existsSync(TRIAL_FILE)) refuse(`no such file: ${TRIAL_FILE}`);
const trialRaw = fs.readFileSync(TRIAL_FILE, 'utf8');
const parsedTrial = TrialFileSchema.safeParse(JSON.parse(trialRaw));
if (!parsedTrial.success) {
  refuse(
    `${path.basename(TRIAL_FILE)} is not a trial file`,
    parsedTrial.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n') +
      '\n\n  The format is in GATEWAY.md under "Running the trial against your server".',
  );
}
const T: TrialFile = parsedTrial.data;
/* The forecast is for the sealed run size; a --smoke reports one trial per cell and is never scored against it. */
for (const sc of T.scenarios) {
  for (const arm of ARMS) {
    if (sc.forecast[arm] > T.trials) refuse(`${sc.name}: forecast for ${arm} is ${sc.forecast[arm]} correct out of ${T.trials} trials`);
  }
}

/**
 * The seal is a commit. cairn:predict seals a forecast on a FINDING; a run has
 * no finding, so the same property -- the forecast provably preceded the
 * numbers -- comes from git directly: the file, forecast and truth included,
 * is tracked and clean in some repository, and the run record names the
 * commit. The scenario file may live in $CAIRN_HOME (make it a repository) or
 * anywhere else that is one.
 */
function sealOf(file: string): { commit: string; committedAt: string; repo: string; sha256: string } {
  const dir = path.dirname(file);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let repo: string;
  try {
    repo = git('rev-parse', '--show-toplevel');
  } catch {
    refuse(
      `${file} is not in a git repository, so its forecast cannot be sealed`,
      `  git -C ${dir} init && git -C ${dir} add ${path.basename(file)} && git -C ${dir} commit -m "seal: gateway trial ${T.name}"`,
    );
  }
  let tracked = true;
  try {
    git('ls-files', '--error-unmatch', file);
  } catch {
    tracked = false;
  }
  const dirty = tracked ? git('status', '--porcelain', '--', file) !== '' : true;
  if (!tracked || dirty) {
    refuse(
      `${path.basename(file)} is ${tracked ? 'modified since its last commit' : 'not committed'} — the forecast in it is not sealed`,
      '  Seal it, then run again:\n\n' +
        `    git -C ${dir} add ${path.basename(file)} && git -C ${dir} commit -m "seal: gateway trial ${T.name}"\n\n` +
        '  Never revise the forecast after seeing a result. Change it, and it is a different run.',
    );
  }
  const [commit, committedAt] = git('log', '-1', '--format=%H%n%cI', '--', file).split('\n');
  return { commit, committedAt, repo, sha256: createHash('sha256').update(trialRaw).digest('hex') };
}

/* 4. The seal, before anything expensive: a forecast that is not committed is not a forecast. */
const SEAL = REGRADE_AT === -1 ? sealOf(TRIAL_FILE) : null;

/* 5. The bundle the gateway arm will actually run. Last of the static checks, because it is the one CI cannot satisfy. */
let bundleAt = 0;
if (REGRADE_AT === -1) {
  const newestMtime = (dir: string): number => {
    let newest = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
    }
    return newest;
  };
  if (!fs.existsSync(BUNDLE)) refuse('dist/cli/mcp-proxy.js is not built', '  npm run cairn:build-cli');
  bundleAt = fs.statSync(BUNDLE).mtimeMs;
  const sourceAt = Math.max(newestMtime(path.join(REPO, 'src')), fs.statSync(path.join(REPO, 'scripts', 'mcp-proxy.ts')).mtimeMs);
  if (sourceAt > bundleAt) refuse('dist/cli/mcp-proxy.js is older than the source', '  npm run cairn:build-cli');
}

/* ---- the run ------------------------------------------------------------ */

const TRIALS = SMOKE ? 1 : T.trials;
const RUN_ID = `${SMOKE ? 'smoke' : 'run'}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${T.name}-${T.model}`;
const OUT_DIR = outAt !== -1 ? path.resolve(argv[outAt + 1]) : path.join(HOME, 'gateway-trials');
if (inside(OUT_DIR, REPO)) refuse(`--out ${OUT_DIR} is inside this repository`, '  Run records and transcripts stay outside the checkout.');
const OUT = path.join(OUT_DIR, `${RUN_ID}.json`);
const TRANSCRIPTS = path.join(OUT_DIR, RUN_ID);

const serverToolName = (raw: string) => `mcp__${T.server.name}__${raw}`;
const mcpPrefix = `mcp__${T.server.name}__`;

interface Trial {
  scenario: string;
  arm: Arm;
  trial: number;
  sessionId: string;
  answer: number | string | null;
  truth: number | string;
  correct: boolean;
  turns: number;
  toolCalls: Record<string, number>;
  /** Calls to the upstream's tools, by any arm; the gateway's own two are not counted. */
  mcpCalls: number;
  costUsd: number;
  durationMs: number;
  denials: unknown[];
  /** From the CLIENT's transcript: tool_result blocks that carried the proxy's label. */
  delivered: { onResult: number; onToolSearch: number };
  /** From the proxy's own ledger in the trial's CAIRN_HOME: what it says it served. */
  proxyLedger: Record<string, number>;
  resultText: string;
  transcript: string | null;
  stderrTail: string;
  error?: string;
}

/** Everything the client's transcript can tell us about one trial. Final answer only. */
function analyse(stdout: string, sc: Scenario) {
  const toolCalls: Record<string, number> = {};
  const delivered = { onResult: 0, onToolSearch: 0 };
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
      }
      if (block.type === 'tool_result' && JSON.stringify(block.content ?? '').includes(LABEL)) {
        const via = useIds.get(String(block.tool_use_id)) ?? '';
        if (via === 'ToolSearch') delivered.onToolSearch++;
        else delivered.onResult++;
      }
    }
  }
  const mcpCalls = Object.entries(toolCalls)
    .filter(([k]) => k.startsWith(mcpPrefix) && !k.endsWith('__cairn_find') && !k.endsWith('__cairn_record'))
    .reduce((a, [, v]) => a + v, 0);

  const resultText = String(result?.result ?? '');
  let answer: number | string | null = null;
  const m = resultText.match(/\{[^{}]*\}/g);
  if (m) {
    for (const cand of m.reverse()) {
      try {
        const j = JSON.parse(cand) as Record<string, unknown>;
        const v = j[sc.key];
        if (typeof v === 'number' || typeof v === 'string') { answer = v; break; }
      } catch { /* next */ }
    }
  }
  let correct = false;
  if (answer !== null) {
    if (typeof sc.truth === 'number') {
      const n = typeof answer === 'number' ? answer : Number(answer);
      correct = Number.isFinite(n) && Math.abs(n - sc.truth) <= sc.tolerance;
    } else {
      correct = String(answer).trim().toLowerCase() === sc.truth.trim().toLowerCase();
    }
  }
  return { toolCalls, mcpCalls, delivered, result, resultText, answer, correct };
}

/** Redacted line by line: the transcript is the raw session against a real server. */
function redactTranscript(stdout: string): string {
  return stdout.split('\n').map((l) => (l ? redactForLedger(l).text : l)).join('\n');
}

function ensureOutDir(): void {
  fs.mkdirSync(TRANSCRIPTS, { recursive: true });
  /* Wherever this lands, it must not be committable by accident. */
  const ignore = path.join(OUT_DIR, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
}

async function runTrial(sc: Scenario, arm: Arm, n: number): Promise<Trial> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-gw-${arm}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-gw-home-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  if (arm === 'gateway') {
    for (const f of fs.readdirSync(path.join(HOME, 'cairn')).filter((f) => f.endsWith('.json'))) {
      fs.copyFileSync(path.join(HOME, 'cairn', f), path.join(home, 'cairn', f));
    }
  }
  const upstream = { command: T.server.command, args: T.server.args, env: T.server.env };
  const mcp =
    arm === 'control'
      ? { mcpServers: { [T.server.name]: upstream } }
      : {
          mcpServers: {
            [T.server.name]: {
              command: 'node',
              args: [PROXY_BIN, '--config', path.join(work, 'upstream.json')],
              env: { CAIRN_HOME: home, CAIRN_AGENT: `trial-${arm}`, CAIRN_SESSION: `trial-${sc.name}-${arm}-${n}` },
            },
          },
        };
  if (arm !== 'control') fs.writeFileSync(path.join(work, 'upstream.json'), JSON.stringify({ mcpServers: { [T.server.name]: upstream } }));
  const cfg = path.join(work, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify(mcp));
  const sessionId = randomUUID();

  const env = { ...process.env };
  for (const k of ['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD', 'CLAUDE_ADDITIONAL_DIRECTORIES', 'CLAUDE_CODE_CHILD_SESSION', 'CAIRN_HOME', 'CAIRN_EVAL', 'CAIRN_RECORD_ARGS']) {
    delete env[k];
  }

  /*
   * Named tools only. The gateway's cairn_find is a read of the trial's own
   * temporary corpus and is permitted on the proxy arms; cairn_record is a
   * write and is not, so a trial cannot be steered into recording.
   */
  const allowed = T.allowedTools.map(serverToolName);
  if (arm !== 'control') allowed.push(serverToolName('cairn_find'));

  const args = [
    '-p', sc.prompt,
    '--model', T.model,
    '--session-id', sessionId,
    '--no-session-persistence',
    '--mcp-config', cfg,
    '--strict-mcp-config',
    '--allowedTools', allowed.join(','),
    '--disallowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,Agent,NotebookEdit,Skill',
    '--max-turns', String(T.maxTurns),
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

  const a = analyse(stdout, sc);
  let transcript: string | null = null;
  if (!NO_TRANSCRIPTS) {
    ensureOutDir();
    const file = path.join(TRANSCRIPTS, `${sc.name}-${arm}-${n}.jsonl`);
    fs.writeFileSync(file, redactTranscript(stdout));
    if (stderr.trim()) fs.writeFileSync(path.join(TRANSCRIPTS, `${sc.name}-${arm}-${n}.stderr`), redactForLedger(stderr).text);
    transcript = path.relative(OUT_DIR, file);
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
    answer: a.answer, truth: sc.truth, correct: a.correct,
    turns: Number(a.result?.num_turns ?? 0),
    toolCalls: a.toolCalls, mcpCalls: a.mcpCalls,
    costUsd: Number(a.result?.total_cost_usd ?? 0),
    durationMs,
    denials: (a.result?.permission_denials as unknown[]) ?? [],
    delivered: a.delivered, proxyLedger,
    resultText: redactForLedger(a.resultText.slice(0, 400)).text,
    transcript,
    stderrTail: redactForLedger(stderr.slice(-600)).text,
    error: code !== 0 ? `claude exited ${code}` : a.result ? undefined : 'no result event',
  };
}

/* ---- the upstream, checked before anything runs -------------------------- */

/** Connect directly, list tools, and hold the allowlist against what is actually there. */
async function verifyAllowlist(): Promise<string[]> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'cairn-gateway-trial', version: '0' }, { capabilities: {} });
  const env = { ...(process.env as Record<string, string>), ...T.server.env };
  delete env.CAIRN_HOME;
  let names: string[];
  try {
    await client.connect(new StdioClientTransport({ command: T.server.command, args: T.server.args, env, stderr: 'pipe' }));
    names = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    await client.close();
  } catch (e) {
    refuse(`could not list the upstream's tools: ${(e as Error).message}`, `  Run it by hand and read stderr:  ${T.server.command} ${T.server.args.join(' ')}`);
  }
  const missing = T.allowedTools.filter((t) => !names.includes(t));
  if (missing.length) {
    refuse(
      `allowedTools names tools the upstream does not offer: ${missing.join(', ')}`,
      `  It offers: ${names.join(', ')}`,
    );
  }
  const writes = T.allowedTools.filter((t) => WRITE_LOOKING.test(t) && !T.readOnlyDespiteName[t]);
  if (writes.length) {
    refuse(
      `allowedTools includes names that read as writes: ${writes.join(', ')}`,
      '  A trial is read-only. If one of these really cannot change anything, say why in the file:\n' +
        `    "readOnlyDespiteName": { "${writes[0]}": "<what it does, and why it cannot write>" }`,
    );
  }
  return names;
}

/** Who wrote the findings the gateway arm will deliver. */
function corpusSummary(): { findings: Array<{ id: string; title: string; by: string[] }>; authors: string[] } {
  const findings: Array<{ id: string; title: string; by: string[] }> = [];
  for (const f of fs.readdirSync(path.join(HOME, 'cairn')).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const parsed = FindingSchema.safeParse(JSON.parse(fs.readFileSync(path.join(HOME, 'cairn', f), 'utf8')));
      if (parsed.success && parsed.data.status === 'active') {
        findings.push({ id: parsed.data.id, title: parsed.data.title, by: [...new Set(parsed.data.observations.map((o) => o.by))] });
      }
    } catch { /* a bad file is the proxy's problem to skip, and it does */ }
  }
  return { findings, authors: [...new Set(findings.flatMap((f) => f.by))] };
}

/* ---- regrade ------------------------------------------------------------ */

/*
 * Recompute the transcript-derived fields of an existing run without
 * rerunning it. A grader can be wrong, and the fix must apply to the trials
 * already paid for, visibly, rather than by rerunning until the numbers look
 * right. Every recomputed field is listed in `regraded`.
 */
function regrade(file: string): void {
  const run = JSON.parse(fs.readFileSync(file, 'utf8')) as { trials: Trial[]; regraded?: string[] };
  const fields = ['answer', 'correct', 'delivered', 'toolCalls', 'mcpCalls'];
  let n = 0;
  for (const t of run.trials) {
    const sc = T.scenarios.find((x) => x.name === t.scenario);
    if (!sc || !t.transcript) continue;
    const transcript = path.join(path.dirname(file), t.transcript);
    if (!fs.existsSync(transcript)) continue;
    const a = analyse(fs.readFileSync(transcript, 'utf8'), sc);
    for (const f of fields) (t as unknown as Record<string, unknown>)[f] = (a as unknown as Record<string, unknown>)[f];
    n++;
  }
  run.regraded = [...new Set([...(run.regraded ?? []), ...fields])];
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`regraded ${n} of ${run.trials.length} trial(s) in ${file}: ${fields.join(', ')}`);
}

/* ---- main --------------------------------------------------------------- */

async function main() {
  if (REGRADE_AT !== -1) { regrade(path.resolve(argv[REGRADE_AT + 1])); return; }

  const seal = SEAL!;
  const upstreamTools = await verifyAllowlist();
  const corpus = corpusSummary();
  if (!corpus.findings.length) refuse(`${path.join(HOME, 'cairn')} has no active findings, so the gateway arm would equal empty`);
  const independent = !corpus.authors.includes(T.scenariosBy);
  const caveat = independent
    ? `scenarios by ${T.scenariosBy}; findings by ${corpus.authors.join(', ')}. Different people.`
    : `scenarios and findings both by ${T.scenariosBy}: the author marking their own work. The gateway number measures delivery of a trap its author planted, not discovery.`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  ensureOutDir();
  const startedAt = new Date().toISOString();
  const trials: Trial[] = [];
  const save = () =>
    fs.writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          runId: RUN_ID, smoke: SMOKE, model: T.model, trialsPerCell: TRIALS, startedAt,
          trialFile: TRIAL_FILE, seal,
          server: { name: T.server.name, command: T.server.command, args: T.server.args, tools: upstreamTools },
          allowedTools: T.allowedTools,
          corpus: { home: HOME, findings: corpus.findings },
          authorship: { scenariosBy: T.scenariosBy, findingsBy: corpus.authors, independent, caveat },
          forecast: Object.fromEntries(T.scenarios.map((s) => [s.name, s.forecast])),
          truth: Object.fromEntries(T.scenarios.map((s) => [s.name, s.truth])),
          bundleAt: new Date(bundleAt).toISOString(),
          transcripts: NO_TRANSCRIPTS ? 'not kept' : 'redacted line by line before writing',
          trials,
        },
        null,
        2,
      )}\n`,
    );

  console.log(`\nGATEWAY TRIAL ${RUN_ID}`);
  console.log(`  upstream   ${T.server.command} ${T.server.args.join(' ')}  (${upstreamTools.length} tools, ${T.allowedTools.length} permitted)`);
  console.log(`  corpus     ${HOME}  (${corpus.findings.length} active finding(s))`);
  console.log(`  seal       ${seal.commit.slice(0, 10)} at ${seal.committedAt}`);
  console.log(`  authorship ${caveat}`);
  console.log(`  model ${T.model}, ${TRIALS} per cell, writing ${path.relative(process.cwd(), OUT)}\n`);

  for (const sc of T.scenarios) {
    for (let n = 1; n <= TRIALS; n++) {
      /* Interleave arms within a trial index so a slow hour or a model
       * hiccup lands on every arm equally rather than on whichever ran last. */
      for (const arm of ARMS) {
        const t = await runTrial(sc, arm, n);
        trials.push(t);
        save();
        console.log(
          `  ${sc.name.padEnd(16)} ${arm.padEnd(8)} #${n}  ${t.correct ? 'CORRECT' : 'wrong  '} answer=${t.answer ?? '-'} truth=${t.truth}` +
            `  mcp=${t.mcpCalls} turns=${t.turns} $${t.costUsd.toFixed(3)} ${(t.durationMs / 1000).toFixed(0)}s` +
            `  delivered=${t.delivered.onResult}/${t.delivered.onToolSearch}` +
            (t.denials.length ? `  DENIALS=${t.denials.length}` : '') +
            (t.error ? `  ERROR=${t.error}` : ''),
        );
      }
    }
  }

  console.log('\nSUMMARY (correct / trials, forecast in brackets)');
  for (const sc of T.scenarios) {
    const row = ARMS.map((arm) => {
      const ts = trials.filter((t) => t.scenario === sc.name && t.arm === arm);
      const ok = ts.filter((t) => t.correct).length;
      const delivered = ts.filter((t) => t.delivered.onResult + t.delivered.onToolSearch > 0).length;
      const calls = ts.reduce((a, t) => a + t.mcpCalls, 0) / Math.max(1, ts.length);
      return `${arm} ${ok}/${ts.length} [${sc.forecast[arm]}]${arm === 'control' ? '' : ` delivered ${delivered}`} (mcp avg ${calls.toFixed(1)})`;
    });
    console.log(`  ${sc.name.padEnd(16)} ${row.join('   ')}`);
  }
  console.log(`\n  ${caveat}`);
  console.log(`\nwritten: ${OUT}`);
  const bad = trials.filter((t) => t.denials.length || t.error);
  if (bad.length) console.log(`\n${bad.length} trial(s) had denials or errors — read them before trusting the summary.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
