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
import { execFileSync } from 'child_process';
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

test('it does nothing when execution is off', () => {
  const w = world(false);
  assert.equal(fire(w), false, 'no agent spawned while checks may not run here');
  assert.equal(fs.readdirSync(w.drafts).filter((n) => n.endsWith('.json')).length, 1, 'the candidate is untouched');
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
