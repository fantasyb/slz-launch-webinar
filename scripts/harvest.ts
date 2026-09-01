/**
 * cairn:harvest — record what agents actually type, on traps they have not seen.
 *
 *   npm run cairn:harvest
 *
 * The field suite is the only honest measurement here, and every knob in the
 * retriever was chosen while watching it: nineteen queries, two scenarios. A
 * number tuned against its own test set is a hypothesis, not a result.
 *
 * So this runs agents over tasks built around traps that have never been used
 * as scenarios, with the corpus available as a tool, and writes down every
 * query they issue. It GRADES NOTHING. Labelling happens afterwards, by hand,
 * and the labels go into data/field-queries.json where they can be argued with.
 *
 * The rule that makes the exercise worth anything: nothing in the retriever
 * moves after these are harvested. If the score falls, that is the measurement
 * working.
 */
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';

/* In the repo, not a scratch directory: a harvest nobody else can run is a
 * number nobody else can dispute. */
const SCRATCH = join(process.cwd(), 'fixtures', 'harvest');
const TRIALS = 3;
const corpus = loadCorpus();

/** Every command any trial ran, so an escape can be diagnosed afterwards. */
const ACTIONS: string[] = [];

/*
 * Two kinds of task, and the second kind is the point of the second harvest.
 *
 * BUILT ON A TRAP (`about` set): ordinary work sitting on top of something the
 * corpus knows. These produced eleven queries, all answerable, and every one
 * ranked first. They also produced about ONE query per trial, asked at the
 * start, about the task in front of the agent.
 *
 * BUILT ON NOTHING (`about` null): a debugging task in a domain the corpus is
 * silent on -- money rounding, retry and backoff, a daylight-saving boundary,
 * CSV encoding. Each has several sub-problems and a planted bug, because an
 * agent that has to form a theory asks mid-task asides, and asides are where
 * unanswerable queries come from. The original suite's negatives were exactly
 * that: a timezone parse, a NaN comparator, wondered about halfway through
 * something else.
 *
 * Silence is the half that protects the reader and it has never been measured
 * on ground the corpus has not seen. These tasks exist to measure it, so they
 * are deliberately NOT built around anything in the ledger. Probed first: all
 * four domains return only unrelated findings.
 */
const TASKS: { name: string; dir: string; about: string | null; task: string }[] = [
  {
    name: 'zod-defaults',
    dir: 'zod',
    about: 'cairn-0004',
    task:
      'In src/config.ts, give `timeoutMs` a default of 5000 and add a `retries` field ' +
      'defaulting to 3, so callers can leave both out. Keep exporting `Config` for callers ' +
      'that build the object themselves — src/client.ts is one. Say DONE when finished.',
  },
  {
    name: 'sidebar-persist',
    dir: 'store',
    about: 'cairn-0009',
    task:
      'Persist whether the sidebar is collapsed, so it comes back the same way on the next ' +
      'page load. Edit src/sidebar.js. Say DONE when finished.',
  },
  {
    name: 'metric-correlation',
    dir: 'stats',
    about: 'cairn-0022',
    task:
      'Write correlate.mjs (plain node) that reports the correlation between every pair of ' +
      'series in metrics.json and flags any pair above 0.9 as strongly related. Run it and ' +
      'tell me which pairs to look at.',
  },
  {
    name: 'review-gate',
    dir: 'gate',
    about: 'cairn-0028',
    task:
      'Our review gate is reporting success on every pull request and the team has stopped ' +
      'trusting it. Work out whether it is actually reviewing anything, and fix it if not.',
  },
  {
    name: 'invoice-rounding',
    dir: 'billing',
    about: null,
    task:
      'Finance says our invoice totals disagree with the payment processor by a cent or two ' +
      'on some invoices. The processor rounds each line to cents before summing; read the ' +
      'README. Work out where ours diverges, fix it, and show me the total for lines.json ' +
      'before and after.',
  },
  {
    name: 'retry-waves',
    dir: 'retry',
    about: null,
    task:
      'The vendor says our traffic arrives in waves and they are rate-limiting us harder for ' +
      'it. We run forty workers against this client. Work out why, fix it, and honour what ' +
      'the vendor tells us on a 429.',
  },
  {
    name: 'dst-weeks',
    dir: 'report',
    about: null,
    task:
      'Support says the Monday numbers in the weekly report disagree with the admin console, ' +
      'but only twice a year. events.json has samples from both of those weekends. Find out ' +
      'why and fix it.',
  },
  {
    name: 'csv-import',
    dir: 'importer',
    about: null,
    task:
      'Ops say the first column of the member import comes through with a strange name, and ' +
      'that some people appear twice. Both are in members.csv. Diagnose each and fix them.',
  },
];

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

/*
 * CWD IS NOT CONTAINMENT.
 *
 * A harvest agent working on a copied fixture wrote its finished answer into
 * this repository's own src/ instead of the copy — two files, nothing tracked
 * overwritten, which was luck rather than design. execFileSync's `cwd` sets
 * where relative paths resolve and stops nothing absolute.
 *
 * This is a guard against accident, not an adversary: these agents are doing
 * ordinary work, and the failure was ordinary too. It refuses any command that
 * names a path outside the trial directory, and it LOGS EVERY COMMAND — the
 * escape could not be diagnosed after the fact because this harness recorded
 * what agents asked and never what they did.
 */
const TRIAL_ESCAPE = new RegExp(`(^|[\\s"'=(])(${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|/home/user|/root)(/|[\\s"']|$)`);

function runBash(cmd: string, cwd: string): string {
  ACTIONS.push(cmd);
  if (TRIAL_ESCAPE.test(cmd)) {
    return 'exit 1\nrefused: this command names a path outside the working directory';
  }
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
        (h.finding.workaround ? `\n  INSTEAD: ${h.finding.workaround.slice(0, 300)}` : '') +
        (h.caveats.length ? `\n  CAVEAT: ${h.caveats.join('; ')}` : ''),
    )
    .join('\n\n');
}

/*
 * The direct assertion, because the pattern guard above is a guess at a
 * mechanism I never observed. This one does not care how an escape happens: it
 * asks the repository whether it changed.
 */
function repoState(): string {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function main() {
  const before = repoState();
  const client = new Anthropic();
  const harvested: { task: string; about: string; trial: number; q: string }[] = [];
  for (const t of TASKS) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      const dir = mkdtempSync(join(tmpdir(), 'harvest-'));
      cpSync(join(SCRATCH, t.dir), dir, { recursive: true });
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: t.task }];
      const queries: string[] = [];
      for (let turn = 0; turn < 12; turn++) {
        const res = await client.messages.create({
          model: 'claude-opus-5',
          max_tokens: 6000,
          thinking: { type: 'adaptive' },
          tools: [bashTool, cairnTool],
          messages,
        });
        if (res.stop_reason === 'refusal') break;
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (!uses.length) break;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const u of uses) {
          const inp = u.input as { command?: string; query?: string };
          if (u.name === 'bash') {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: runBash(inp.command ?? '', dir) });
          } else {
            const q = (inp.query ?? '').trim();
            if (q) { queries.push(q); harvested.push({ task: t.name, about: t.about, trial, q }); }
            results.push({ type: 'tool_result', tool_use_id: u.id, content: runCairn(q) });
          }
        }
        messages.push({ role: 'user', content: results });
      }
      rmSync(dir, { recursive: true, force: true });
      console.log(`  ${t.name} trial ${trial}: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
      for (const q of queries) console.log(`      ${q.slice(0, 104)}`);
    }
  }
  const after = repoState();
  if (after !== before) {
    console.log('\n  !! THE REPOSITORY CHANGED DURING THIS RUN. A trial wrote outside its directory.');
    for (const line of after.split('\n').filter((l) => l && !before.includes(l))) console.log(`     ${line}`);
    console.log('     Commands are logged below; find the one that did it.\n');
    for (const a of ACTIONS) console.log(`     $ ${a.replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  const out = join(tmpdir(), 'harvest.json');
  writeFileSync(out, JSON.stringify(harvested, null, 2));
  console.log(`\n  ${harvested.length} queries from ${TASKS.length} tasks x ${TRIALS} trials -> ${out}`);
  console.log('  Label them by hand. Nothing in the retriever moves before they are in.\n');
}
void main();
