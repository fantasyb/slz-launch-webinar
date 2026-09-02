/**
 * cairn:gateway-trial — does an agent working THROUGH the gateway do better?
 *
 *   npm run cairn:gateway-trial -- --discover "npx -y @acme/their-mcp"   # which tools it would permit, and why
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
 *   - No server-wide tool permission, and no tool names typed by a person.
 *     The old harness passed `--allowedTools mcp__records`, which
 *     pre-approves every tool the server offers, writes included; the
 *     version after it made the operator type each tool's wire name into
 *     the file, which made the person with production credentials loaded
 *     the one guessing strings. Now the harness connects, reads the
 *     server's own tools/list, and decides per tool, showing its work:
 *     a tool declaring `readOnlyHint: true` is permitted by declaration; one
 *     declaring `destructiveHint: true` or `readOnlyHint: false` is excluded
 *     by declaration; one declaring nothing is judged by its name, and a
 *     name that reads as a write (create/update/delete/upsert/execute/...)
 *     is excluded. The operator reviews the printed list. `allowedTools`
 *     narrows it further if wanted; `readOnlyDespiteName` overrules an
 *     exclusion and has to say why. Nothing that can write reaches an
 *     unattended model without a written acknowledgement, which is the same
 *     invariant as before with the server's own statement added to it.
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
 *   - The tool surface is verified continuously, not once. One connection
 *     to the server stays open for the whole run; before every trial, and
 *     at the end, the list is read again and diffed against the one the
 *     tools were chosen from. A permitted tool that vanished, was renamed,
 *     changed its annotations or its schema, or a tool that appeared -- any
 *     of it stops the run and says so, and the record carries the surface
 *     at start, at end, and every change between. A result measured
 *     against a surface that moved underneath it is not a result.
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
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { classify, diffSurface, shapeOf, type ToolShape, type SurfaceChange } from '../src/lib/cairn/toolsurface';

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
  /** The question. The reply instruction is appended unless the prompt already gives one. */
  prompt: z.string().min(20),
  /** The key the agent is told to reply with: {"<key>": <answer>}. */
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('answer'),
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
  name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  /** The command line, or the object your client's mcp.json has for it. A string gets the trial's name. */
  server: z.union([z.string().min(1), ServerSchema]),
  /** Optional narrowing: only these wire names are considered. Discovery still decides whether each may be called. */
  allowedTools: z.array(z.string().min(1)).min(1).optional(),
  /** Overrule an exclusion, by wire name, with the reason written down. */
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


/* ---- arguments ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const DISCOVER_AT = argv.indexOf('--discover');
const SMOKE = argv.includes('--smoke');
const NO_TRANSCRIPTS = argv.includes('--no-transcripts');
const REGRADE_AT = argv.indexOf('--regrade');
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--regrade', '--out', '--discover'].includes(argv[i - 1]));
const outAt = argv.indexOf('--out');

function refuse(what: string, how = ''): never {
  console.error(`\nREFUSED — ${what}\n${how ? `\n${how}\n` : ''}`);
  process.exit(2);
}

/* ---- what the server says about its tools, and what that decides -------- */

type Annotations = NonNullable<Tool['annotations']>;
interface ToolChoice {
  name: string;
  permitted: boolean;
  /** One line a person reads: where the decision came from. */
  reason: string;
  annotations: Annotations | null;
  /** Set when readOnlyDespiteName overruled an exclusion. */
  overridden?: string;
}

/** The rules live in src/lib/cairn/toolsurface.ts, shared with the gateway; this only lays them over the file. */
function chooseTools(tools: Tool[], file: { allowedTools?: string[]; readOnlyDespiteName: Record<string, string> }): ToolChoice[] {
  return tools.map((t) => ({ name: t.name, annotations: (t.annotations ?? null) as Annotations | null, ...classify(t, { allowed: file.allowedTools, overrides: file.readOnlyDespiteName }) }));
}

function printChoices(choices: ToolChoice[]): void {
  const w = Math.max(8, ...choices.map((c) => c.name.length));
  for (const c of choices) {
    console.log(`  ${c.permitted ? 'permit ' : 'exclude'}  ${c.name.padEnd(w)}  ${c.reason}${c.overridden ? `: "${c.overridden}"` : ''}`);
  }
  const n = choices.filter((c) => c.permitted).length;
  console.log(`  ${n} of ${choices.length} permitted. The agent can call nothing else.`);
}

/** Connect directly and read tools/list, every page. */
async function listUpstreamTools(server: { command: string; args: string[]; env: Record<string, string> }): Promise<Tool[]> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'cairn-gateway-trial', version: '0' }, { capabilities: {} });
  const env = { ...(process.env as Record<string, string>), ...server.env };
  delete env.CAIRN_HOME;
  const tools: Tool[] = [];
  try {
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'pipe' }));
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    await client.close();
  } catch (e) {
    refuse(`could not list the upstream's tools: ${(e as Error).message}`, `  Run it by hand and read stderr:  ${server.command} ${server.args.join(' ')}`);
  }
  return tools;
}

const splitCommand = (line: string) => {
  const [command, ...args] = line.trim().split(/\s+/);
  return { command, args, env: {} as Record<string, string> };
};

/* --discover: connect, decide, print, exit. No home, no seal, no model. */
if (DISCOVER_AT !== -1) {
  const line = argv[DISCOVER_AT + 1];
  if (!line) refuse('--discover needs the server command', '  npm run cairn:gateway-trial -- --discover "npx -y @acme/their-mcp"');
  const server = splitCommand(line);
  listUpstreamTools(server).then((tools) => {
    console.log(`\n${server.command} ${server.args.join(' ')} offers ${tools.length} tool(s). A trial would:\n`);
    printChoices(chooseTools(tools, { readOnlyDespiteName: {} }));
    console.log(
      '\n  "permit" needs nothing from you. To overrule an "exclude", add to the scenario file:\n' +
        '    "readOnlyDespiteName": { "<tool>": "<what it does, and why it cannot write>" }\n',
    );
  });
} else {
const trialFileArg = positional[0];
if (!trialFileArg) {
  refuse(
    'no scenario file',
    '  usage: CAIRN_HOME=<corpus> npm run cairn:gateway-trial -- <trial.json> [--smoke] [--no-transcripts] [--out <dir>]\n' +
      '         CAIRN_HOME=<corpus> npm run cairn:gateway-trial -- --regrade <run.json> <trial.json>\n' +
      '         npm run cairn:gateway-trial -- --discover "<server command>"\n' +
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
const SERVER = typeof T.server === 'string' ? { name: T.name, ...splitCommand(T.server) } : T.server;
/**
 * The reply instruction is the harness's, not the operator's: the grader
 * reads {"<key>": <answer>} and the operator should only have to write the
 * question. A prompt that already asks for JSON is sent as written.
 */
const promptFor = (sc: Scenario) =>
  sc.prompt.includes('{"') ? sc.prompt : `${sc.prompt.trim()}\n\nUse the tools available to find out. When you are done, reply with only a JSON object of the form {"${sc.key}": <answer>} and nothing else.`;
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

const serverToolName = (raw: string) => `mcp__${SERVER.name}__${raw}`;
const mcpPrefix = `mcp__${SERVER.name}__`;

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

async function runTrial(sc: Scenario, arm: Arm, n: number, permitted: string[]): Promise<Trial> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-gw-${arm}-`));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-gw-home-'));
  fs.mkdirSync(path.join(home, 'cairn'));
  if (arm === 'gateway') {
    for (const f of fs.readdirSync(path.join(HOME, 'cairn')).filter((f) => f.endsWith('.json'))) {
      fs.copyFileSync(path.join(HOME, 'cairn', f), path.join(home, 'cairn', f));
    }
  }
  const upstream = { command: SERVER.command, args: SERVER.args, env: SERVER.env };
  const mcp =
    arm === 'control'
      ? { mcpServers: { [SERVER.name]: upstream } }
      : {
          mcpServers: {
            [SERVER.name]: {
              command: 'node',
              args: [PROXY_BIN, '--config', path.join(work, 'upstream.json')],
              env: { CAIRN_HOME: home, CAIRN_AGENT: `trial-${arm}`, CAIRN_SESSION: `trial-${sc.name}-${arm}-${n}` },
            },
          },
        };
  if (arm !== 'control') fs.writeFileSync(path.join(work, 'upstream.json'), JSON.stringify({ mcpServers: { [SERVER.name]: upstream } }));
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
  const allowed = permitted.map(serverToolName);
  if (arm !== 'control') allowed.push(serverToolName('cairn_find'));

  const args = [
    '-p', promptFor(sc),
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

/* ---- the upstream, read before anything runs and re-read before every trial */

/**
 * One connection to the server, open for the whole run, so the list can be
 * re-read cheaply and the server's own list_changed notification is seen.
 * Each trial's Claude Code spawns its own copy of the server, so this one
 * sees the same surface those do; what it cannot see is a server whose
 * tool list differs per process, which nothing outside the server could.
 */
class Watcher {
  private client: import('@modelcontextprotocol/sdk/client/index.js').Client | null = null;
  private closed = false;
  /** The server said its list changed, since the last look. */
  changed = false;
  shapes: ToolShape[] = [];
  events: Array<{ at: string; when: string; changes: SurfaceChange[] }> = [];

  constructor(private server: { command: string; args: string[]; env: Record<string, string> }) {}

  private async open(): Promise<void> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
    const client = new Client({ name: 'cairn-gateway-trial', version: '0' }, { capabilities: {} });
    const env = { ...(process.env as Record<string, string>), ...this.server.env };
    delete env.CAIRN_HOME;
    const transport = new StdioClientTransport({ command: this.server.command, args: this.server.args, env, stderr: 'pipe' });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { this.changed = true; });
    await client.connect(transport);
    const sdkOnClose = transport.onclose;
    transport.onclose = () => { this.closed = true; sdkOnClose?.(); };
    this.client = client;
    this.closed = false;
  }

  private async list(): Promise<Tool[]> {
    if (!this.client || this.closed) await this.open();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client!.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /** First look: the surface the tools are chosen from. */
  async connect(): Promise<Tool[]> {
    let tools: Tool[];
    try {
      tools = await this.list();
    } catch (e) {
      refuse(`could not list the upstream's tools: ${(e as Error).message}`, `  Run it by hand and read stderr:  ${this.server.command} ${this.server.args.join(' ')}`);
    }
    this.shapes = tools.map(shapeOf);
    return tools;
  }

  /** Look again, and say what moved since the tools were chosen. */
  async check(when: string): Promise<SurfaceChange[]> {
    let tools: Tool[];
    try {
      tools = await this.list();
    } catch (e) {
      return [{ kind: 'vanished', tool: '(server)', detail: `the server could not be listed ${when}: ${(e as Error).message}` }];
    }
    this.changed = false;
    const now = tools.map(shapeOf);
    const changes = diffSurface(this.shapes, now);
    if (changes.length) {
      this.events.push({ at: new Date().toISOString(), when, changes });
      this.shapes = now;
    }
    return changes;
  }

  async close(): Promise<void> {
    try { await this.client?.close(); } catch { /* gone already */ }
  }
}


/** List the server's tools, decide per tool, and hold any allowedTools against what is there. */
async function discover(watcher: Watcher): Promise<{ tools: string[]; choices: ToolChoice[]; permitted: string[] }> {
  const tools = await watcher.connect();
  const names = tools.map((t) => t.name);
  const missing = (T.allowedTools ?? []).filter((t) => !names.includes(t));
  if (missing.length) refuse(`allowedTools names tools the upstream does not offer: ${missing.join(', ')}`, `  It offers: ${names.join(', ')}`);
  const unknownOverride = Object.keys(T.readOnlyDespiteName).filter((t) => !names.includes(t));
  if (unknownOverride.length) refuse(`readOnlyDespiteName names tools the upstream does not offer: ${unknownOverride.join(', ')}`, `  It offers: ${names.join(', ')}`);
  const choices = chooseTools(tools, T);
  const permitted = choices.filter((c) => c.permitted).map((c) => c.name);
  if (!permitted.length) {
    printChoices(choices);
    refuse('discovery permitted no tools, so the agent could call nothing', '  readOnlyDespiteName overrules an exclusion, with a reason written down.');
  }
  return { tools: names, choices, permitted };
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
  const watcher = new Watcher(SERVER);
  const { tools: upstreamTools, choices, permitted } = await discover(watcher);
  const surfaceAtStart = watcher.shapes;
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
  let stopped: string | null = null;
  const save = () =>
    fs.writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          runId: RUN_ID, smoke: SMOKE, model: T.model, trialsPerCell: TRIALS, startedAt,
          trialFile: TRIAL_FILE, seal,
          server: { name: SERVER.name, command: SERVER.command, args: SERVER.args, tools: upstreamTools },
          /* Every tool the server offered, what was decided about it, and why. */
          tools: choices,
          permitted,
          prompts: Object.fromEntries(T.scenarios.map((s) => [s.name, promptFor(s)])),
          corpus: { home: HOME, findings: corpus.findings },
          authorship: { scenariosBy: T.scenariosBy, findingsBy: corpus.authors, independent, caveat },
          forecast: Object.fromEntries(T.scenarios.map((s) => [s.name, s.forecast])),
          truth: Object.fromEntries(T.scenarios.map((s) => [s.name, s.truth])),
          bundleAt: new Date(bundleAt).toISOString(),
          transcripts: NO_TRANSCRIPTS ? 'not kept' : 'redacted line by line before writing',
          /* The tool surface the tools were chosen from, every change seen during the run, and the surface at the end. */
          surface: { atStart: surfaceAtStart, changes: watcher.events, atEnd: watcher.shapes },
          stopped,
          trials,
        },
        null,
        2,
      )}\n`,
    );

  console.log(`\nGATEWAY TRIAL ${RUN_ID}`);
  console.log(`  upstream   ${SERVER.command} ${SERVER.args.join(' ')}  (${upstreamTools.length} tools)\n`);
  printChoices(choices);
  console.log('');
  console.log(`  corpus     ${HOME}  (${corpus.findings.length} active finding(s))`);
  console.log(`  seal       ${seal.commit.slice(0, 10)} at ${seal.committedAt}`);
  console.log(`  authorship ${caveat}`);
  console.log(`  model ${T.model}, ${TRIALS} per cell, writing ${path.relative(process.cwd(), OUT)}\n`);

  for (const sc of T.scenarios) {
    for (let n = 1; n <= TRIALS; n++) {
      /* Interleave arms within a trial index so a slow hour or a model
       * hiccup lands on every arm equally rather than on whichever ran last. */
      for (const arm of ARMS) {
        /*
         * The premise, re-read. A run whose tool surface moved underneath it
         * is not a result, so the list is compared before every trial and
         * any change stops the run with the record written so far.
         */
        const moved = await watcher.check(`before ${sc.name} ${arm} #${n}`);
        if (moved.length) {
          stopped = `tool surface changed before ${sc.name} ${arm} #${n}`;
          save();
          console.log(`\nSTOPPED — the server's tools changed under the run, before ${sc.name} ${arm} #${n}:\n`);
          for (const c of moved) console.log(`  ${c.kind.padEnd(12)} ${c.detail}`);
          console.log(`\n  ${trials.length} trial(s) are in ${OUT} with stopped set; nothing after this point was run.`);
          console.log('  Re-read the list, update the findings and the forecast if they need it, seal again, and run again.\n');
          await watcher.close();
          process.exit(3);
        }
        const t = await runTrial(sc, arm, n, permitted);
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

  const movedAtEnd = await watcher.check('at end');
  await watcher.close();
  save();
  if (movedAtEnd.length) {
    console.log('\nWARNING — the server\'s tools changed after the last trial. The trials ran against the surface at start; the record carries both:\n');
    for (const c of movedAtEnd) console.log(`  ${c.kind.padEnd(12)} ${c.detail}`);
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
}
