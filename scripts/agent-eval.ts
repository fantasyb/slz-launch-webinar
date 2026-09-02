/**
 * cairn:agent-eval — the corpus used the way an agent would actually use it.
 *
 *   npm run cairn:agent-eval
 *
 * Every other measurement here has been a proxy. `cairn:eval` asks whether a
 * finding's own prose retrieves it, which tests the retriever against text a
 * human wrote about the failure. This runs the failing commands, captures what
 * the tools actually print, and hands that to the retriever verbatim — the
 * query an agent has in its scrollback at the moment it gets stuck.
 *
 * WHY THIS IS THE LEAST CONTAMINATED TEST AVAILABLE
 *
 * The queries are produced by curl, ripgrep, bash and node, not by anyone who
 * has seen the corpus. They cannot have been tuned against, because they are
 * generated fresh on every run and carry this machine's specific paths, sizes
 * and addresses. Nothing about them was chosen to make the retriever look good
 * except which commands to run.
 *
 * WHAT IS STILL BIASED, STATED PLAINLY
 *
 * I chose the scenarios and I labelled the expected answer. Scenario choice is
 * a real bias: these are failures this corpus happens to cover, so this
 * measures precision on covered ground and says nothing about recall over
 * failures nobody has written up. It is an upper bound, not an estimate.
 *
 * Where two findings genuinely describe the same trap, both are accepted.
 * Ranking one sibling above the other is a coin flip the corpus does not
 * contain a preference about, and scoring it as an error would measure the
 * coin rather than the retriever.
 *
 * Latency is the full cold path: a spawned process, exactly what the agent
 * waits for. No warm-index numbers appear here.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { loadCorpus } from '../src/lib/cairn/load';
import { retrieve } from '../src/lib/cairn/retrieval';

/* This is a measurement, not usage: keep replays out of the ledger. */
process.env.CAIRN_EVAL = '1';

const exec = promisify(execFile);

interface Scenario {
  what: string;
  /** true when the corpus SHOULD have nothing to say. */
  expectSilence?: boolean;
  /** Run through sh so shell failures (command not found) are captured too. */
  cmd: string;
  /** Any of these counts as correct. Empty when silence is the right answer. */
  accept: string[];
  why: string;
}

const SCENARIOS: Scenario[] = [
  {
    what: 'fetching a host the sandbox proxy does not allow',
    cmd: 'curl -sS --max-time 10 https://creativecommons.org',
    accept: ['cairn-0001'],
    why: 'a 403 from the allowlist proxy reads as a dead host',
  },
  {
    what: 'grepping for a literal brace',
    cmd: "rg 'interface{}' /etc/hostname",
    accept: ['cairn-0003'],
    why: 'ripgrep parses { as a repetition quantifier',
  },
  {
    what: 'looking up DNS the obvious way',
    cmd: 'dig +short example.com',
    accept: ['cairn-0002'],
    why: 'no dig, no nslookup in this image',
  },
  {
    what: 'checking free space before a large write',
    cmd: 'df -h .',
    accept: ['cairn-0008'],
    why: 'df reports the underlying device, not the session allowance. NOTE: this '
      + 'is successful output, not an error -- an agent reaches this by checking '
      + 'before a write, not by failing. Weaker scenario than the others.',
  },
  /*
   * Dropped: `node -e "require('playwright')"` produced "Cannot find module
   * 'playwright'", which is a missing package and NOT the preinstalled-browser
   * trap cairn-0007 and cairn-0012 describe. Accepting those two for it scored
   * a right answer to a question nobody asked, and inflated P@1 by a sixth.
   * Reproducing the real trap needs playwright installed and a browser
   * download, which is not something a test should do.
   */
  {
    what: 'trying to resolve an MX record with what is on the box',
    cmd: 'getent ahosts example.com >/dev/null && nslookup -type=mx example.com',
    accept: ['cairn-0002'],
    why: 'getent answers A/AAAA only, and nslookup is absent',
  },
  /*
   * NEGATIVE CONTROLS — failures this corpus has never heard of.
   *
   * Precision on covered ground is the easy half. The half that decides
   * whether this is safe to wire into a debugging loop is what happens when
   * the corpus knows nothing: a retriever that always returns its best guess
   * hands an agent a confident, irrelevant finding at the exact moment it is
   * least able to judge one, and the agent acts on it. Returning nothing is
   * the correct answer far more often than any ranking function admits.
   *
   * These are real failures from tools the corpus has no finding about.
   */
  {
    what: 'a python import error, nothing in the corpus about it',
    cmd: 'python3 -c "import nonexistent_module_xyz"',
    accept: [],
    expectSilence: true,
    why: 'no finding covers python imports',
  },
  {
    what: 'a git failure, nothing in the corpus about it',
    cmd: 'git checkout does-not-exist-branch-xyz',
    accept: [],
    expectSilence: true,
    why: 'no finding covers git refs',
  },
  {
    what: 'a permission error, nothing in the corpus about it',
    // /etc/shadow was the first attempt and it was not a test: this container
    // runs as root, so cat SUCCEEDED and the "query" was the file's contents.
    // It passed for four runs while testing nothing. /etc/gshadow is
    // mode 0640 and denies even root on some images; where it does not, the
    // scenario is honestly weaker rather than silently fake.
    cmd: 'cat /etc/gshadow 2>&1 >/dev/null; cat /proc/1/mem 2>&1 >/dev/null',
    accept: [],
    expectSilence: true,
    why: 'no finding covers file permissions',
  },
];

/** What an agent actually pastes: the tail of what just went wrong, not a summary. */
function asQuery(output: string): string {
  const lines = output.trim().split('\n').filter((l) => l.trim());
  return lines.slice(0, 4).join(' ').slice(0, 240);
}

async function main() {
  const all = loadCorpus();
  const bundled = existsSync('dist/cli/find.js');

  console.log('\nAGENT SIMULATION — real commands, real stderr, cold-path latency');
  console.log('='.repeat(66));
  if (!bundled) console.log('(dist/cli not built — latency will show the tsx fallback)\n');

  let correct = 0;
  let rr = 0;
  const latencies: number[] = [];

  for (const s of SCENARIOS) {
    let output = '';
    try {
      const r = await exec('/bin/sh', ['-c', s.cmd], { maxBuffer: 1 << 22 });
      output = r.stdout + r.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      // NOT err.message: node's exec prepends "Command failed: /bin/sh -c ...",
      // which is this harness talking, not the tool. It leaked words like
      // "command" and "failed" into every query and echoed the command line
      // back into the text being matched -- both of which flatter the result.
      output = (err.stdout ?? '') + (err.stderr ?? '');
    }
    const q = asQuery(output);

    // Rank in-process, so the accuracy number is not perturbed by process noise.
    const hits = retrieve(q, all);
    const rank = hits.findIndex((h) => s.accept.includes(h.finding.id));

    // Latency through the real spawned CLI, which is what the agent pays.
    const t = process.hrtime.bigint();
    if (bundled) await exec(process.execPath, ['dist/cli/find.js', q], { maxBuffer: 1 << 22 });
    else await exec('npx', ['tsx', 'scripts/find.ts', q], { maxBuffer: 1 << 22 });
    const took = Number(process.hrtime.bigint() - t) / 1e6;
    latencies.push(took);

    /*
     * On unknown ground, silence is not the only correct answer any more.
     * A returned finding clearly labelled WEAK, with the reasons, is equally
     * safe -- an LLM discards it in a dozen tokens -- and costs no recall
     * elsewhere. What is NOT acceptable is a confident wrong answer.
     */
    const silent = hits.length === 0 || hits.every((h) => h.strength === 'weak');
    if (s.expectSilence) {
      if (silent) { correct++; rr += 1; }
    } else {
      if (rank === 0) correct++;
      if (rank >= 0) rr += 1 / (rank + 1);
    }

    const verdict = s.expectSilence
      ? silent ? 'QUIET' : 'NOISE'
      : rank === 0 ? 'HIT  ' : rank > 0 ? `#${rank + 1}   ` : 'MISS ';
    console.log(`\n${verdict} ${s.what}`);
    console.log(`  $ ${s.cmd}`);
    console.log(`  saw:      ${JSON.stringify(q.slice(0, 88))}`);
    console.log(
      `  returned: ${hits.slice(0, 3).map((h) => h.finding.id + (h.strength === 'weak' ? '(weak)' : '')).join(', ') || '(nothing)'}` +
        `   expected: ${s.expectSilence ? 'nothing' : s.accept.join(', ')}`,
    );
    console.log(`  ${took.toFixed(0)} ms end to end`);
  }

  const positives = SCENARIOS.filter((x) => !x.expectSilence).length;
  const negatives = SCENARIOS.length - positives;
  const n = SCENARIOS.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log('\n' + '='.repeat(66));
  console.log(
    `${correct}/${n} correct   over ${positives} covered failures and ${negatives} the corpus ` +
      'has never heard of',
  );
  console.log(
    `latency  median ${sorted[Math.floor(n / 2)].toFixed(0)} ms   ` +
      `max ${sorted[n - 1].toFixed(0)} ms   (full cold path, spawned)`,
  );
  console.log(
    '\nScenario choice is mine, so this is precision on ground the corpus covers.\n' +
      'It says nothing about failures nobody has written up. Upper bound, not estimate.',
  );
}

void main();
