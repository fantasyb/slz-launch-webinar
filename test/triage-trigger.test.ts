/**
 * The trigger fires a triage agent WHEN IT CAN and never otherwise: execution
 * must be enabled for the corpus, candidates must be pending, and no run may
 * already hold the lock. When it does fire it spawns detached and returns at once.
 * These pin the gate (it does not spawn when it must not) and the spawn (it does
 * when it should), with a mock command standing in for the agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { triageBrief } from '../src/lib/cairn/triageBrief';

const SCRIPT = path.join(process.cwd(), 'scripts', 'triage-trigger.ts');

/** A corpus with execution on/off, one drafts dir, and a mock spawn that drops a marker. */
function world(enabled: boolean, candidates = 1): { home: string; drafts: string; marker: string; policy: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-trig-'));
  fs.mkdirSync(path.join(home, 'cairn'), { recursive: true });
  const drafts = path.join(home, 'drafts');
  fs.mkdirSync(drafts, { recursive: true });
  for (let i = 0; i < candidates; i++) {
    fs.writeFileSync(path.join(drafts, `c${i}.json`), JSON.stringify({ tool: 'query', expectation: 'x', reality: 'y', mechanism_or_update: 'z' }));
  }
  const policy = path.join(home, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify(enabled ? { [home]: { enabled: true } } : {}));
  return { home, drafts, marker: path.join(drafts, '.spawned'), policy };
}

/** Run the trigger; the mock agent writes .spawned. Returns whether it spawned within the window. */
function fire(w: { home: string; policy: string; marker: string }): boolean {
  execFileSync('npx', ['tsx', SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CAIRN_HOME: w.home,
      CAIRN_POLICY: w.policy,
      CAIRN_TRIAGE_CMD: `printf ran > "${w.marker}"`,
    },
  });
  /* The spawn is detached; give it a beat to land its marker. */
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (fs.existsSync(w.marker)) return true;
    try {
      execFileSync('sh', ['-c', 'sleep 0.05']);
    } catch {
      /* ignore */
    }
  }
  return fs.existsSync(w.marker);
}

test('it spawns a triage agent when execution is on and candidates wait', () => {
  const w = world(true);
  assert.equal(fire(w), true, 'the agent was spawned');
  assert.ok(fs.existsSync(path.join(w.drafts, '.triage-brief.md')), 'and the brief was written for it');
});

test('it spawns from --home alone, with CAIRN_HOME unset (the installed hook shape)', () => {
  /* The hook is wired as `--home <corpus>` with no CAIRN_HOME. executionPolicy()
   * reads CAIRN_HOME, so before the fix the policy for the wrong corpus was checked
   * and triage silently never fired on any machine whose corpus is not the default. */
  const w = world(true);
  const env: NodeJS.ProcessEnv = { ...process.env, CAIRN_POLICY: w.policy, CAIRN_TRIAGE_CMD: `printf ran > "${w.marker}"` };
  delete env.CAIRN_HOME;
  execFileSync('npx', ['tsx', SCRIPT, '--home', w.home], { encoding: 'utf8', env });
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !fs.existsSync(w.marker)) {
    try { execFileSync('sh', ['-c', 'sleep 0.05']); } catch { /* ignore */ }
  }
  assert.equal(fs.existsSync(w.marker), true, 'triage spawned from --home alone — the policy check aligned to the given corpus');
});

test('the default spawn runs the resolved claude binary and captures output to the log', () => {
  /* No CAIRN_TRIAGE_CMD: exercises the direct-spawn path. A mock "claude" reads the
   * brief on stdin and writes to stdout, which must land in drafts/.triage.log —
   * the path that used to fail silently when the shell could not resolve claude. */
  const w = world(true);
  const mock = path.join(w.home, 'mock-claude.sh');
  fs.writeFileSync(mock, '#!/bin/sh\ncat > /dev/null\necho "mock triage ran"\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, CAIRN_HOME: w.home, CAIRN_POLICY: w.policy, CAIRN_CLAUDE_BIN: mock };
  delete env.CAIRN_TRIAGE_CMD;
  execFileSync('npx', ['tsx', SCRIPT], { encoding: 'utf8', env });
  const log = path.join(w.drafts, '.triage.log');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('mock triage ran'))) {
    try { execFileSync('sh', ['-c', 'sleep 0.05']); } catch { /* ignore */ }
  }
  assert.match(fs.readFileSync(log, 'utf8'), /mock triage ran/, 'agent output landed in .triage.log via the direct spawn');
});

test('a batch is bounded so a big backlog does not run as one giant brief', () => {
  const w = world(true, 25);
  const env: NodeJS.ProcessEnv = { ...process.env, CAIRN_HOME: w.home, CAIRN_POLICY: w.policy, CAIRN_TRIAGE_CMD: `printf ran > "${w.marker}"`, CAIRN_TRIAGE_BATCH: '10' };
  /* The breadcrumb is on stderr; merge it so we can read it. */
  const out = execSync(`npx tsx "${SCRIPT}" 2>&1`, { encoding: 'utf8', env });
  assert.match(out, /10 of 25/, 'took a bounded batch of the backlog, not all 25 at once');
});

test('it spawns no agent when execution is off, and leaves a non-sleep draft untouched', () => {
  const w = world(false);
  assert.equal(fire(w), false, 'no agent spawned while checks may not run here');
  assert.equal(fs.readdirSync(w.drafts).filter((n) => n.endsWith('.json')).length, 1, 'a gateway draft is not a sleep candidate; the consolidation pass does not touch it');
});

test('when execution is off it spawns the consolidation pass instead, and the candidate is served', () => {
  /* The machine that may not run checks used to be inert: this is the path that
   * makes it learn. A real sleep candidate is pending; the trigger spawns
   * `cairn-sleep --consolidate` detached, and a finding appears in cairn/. */
  const w = world(false, 0);
  fs.writeFileSync(path.join(w.drafts, 'sleep-t-mcp__sf__query_records-3-abc.json'), JSON.stringify({
    _kind: 'sleep-candidate',
    source: 't.jsonl',
    tool: 'mcp__sf__query_records',
    surprisal: 3,
    why: ['the agent revised its model of the tool after a notable result'],
    expectation: 'I expect the churned contacts for this quarter to come back.',
    reality: '{"records":[]}',
    mechanism_or_update: 'Zero rows — actually it turns out the MCP server is bound to the sandbox org, so every query returns empty without any error.',
    evidence: [{ command: 'mcp__sf__query_records {"object":"Contact"}', output: '{"records":[]}' }],
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, CAIRN_HOME: w.home, CAIRN_POLICY: w.policy };
  delete env.CAIRN_AUTO_CONSOLIDATE;
  const out = execSync(`npx tsx "${SCRIPT}" 2>&1`, { encoding: 'utf8', env });
  assert.match(out, /spawned the consolidation pass/, 'the breadcrumb names what ran');
  const corpus = path.join(w.home, 'cairn');
  const served = () => fs.readdirSync(corpus).filter((n) => n.endsWith('.json'));
  /* Detached, and possibly through the tsx fallback: allow it a generous window. */
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && served().length === 0) {
    try { execFileSync('sh', ['-c', 'sleep 0.1']); } catch { /* ignore */ }
  }
  assert.equal(served().length, 1, `a finding was consolidated into cairn/ (log: ${fs.existsSync(path.join(w.drafts, '.consolidate.log')) ? fs.readFileSync(path.join(w.drafts, '.consolidate.log'), 'utf8') : 'none'})`);
  const f = JSON.parse(fs.readFileSync(path.join(corpus, served()[0]), 'utf8'));
  assert.equal(f.observations[0].by, 'cairn-sleep');
  assert.equal(f.check.manual, true, 'no check runs on a machine where execution is off — the finding says so');
  assert.equal(fs.readdirSync(w.drafts).filter((n) => n.endsWith('.json') && !n.startsWith('.')).length, 0, 'the queue drained');
});

test('it does nothing when no candidates are pending', () => {
  const w = world(true, 0);
  assert.equal(fire(w), false, 'nothing to triage, nothing spawned');
});

test('it does not spawn a second agent while one holds the lock', () => {
  const w = world(true);
  fs.writeFileSync(path.join(w.drafts, '.triage.lock'), `999 ${new Date().toISOString()}\n`);
  assert.equal(fire(w), false, 'a fresh lock means a run is already in flight');
});

test('the brief carries the candidates and the discrimination bar', () => {
  const pending = [{ file: '/d/c0.json', data: { tool: 'query_records', expectation: 'churned contacts', reality: 'empty', mechanism_or_update: 'wrong org' } }];
  const brief = triageBrief('~/pilot', pending);
  assert.match(brief, /query_records/, 'names the tool');
  assert.match(brief, /wrong org/, 'carries the correction');
  assert.match(brief, /exits 0[\s\S]{0,20}when the trap is present/, 'states the discriminating-check bar');
  assert.match(brief, /not-live/, 'and what to do when the trap is not live here');
});
