/**
 * The trial harness refuses before it runs a model, and the refusals are the
 * safety properties: it is the one script here that is pointed at a real,
 * credentialed server, in an agent that is permitted to call its tools.
 *
 * Each case spawns the harness the way the operator does and asserts on the
 * refusal text, because the property is "it stops, and says why" and a unit
 * test of an internal function would not prove the stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();

function trialFile(dir: string, patch: Record<string, unknown> = {}): string {
  const file = path.join(dir, 'trial.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: 't',
      server: { name: 'records', command: 'node', args: [path.join(REPO, 'fixtures', 'mcp', 'records.mjs')] },
      allowedTools: ['query_records'],
      scenariosBy: 'someone',
      scenarios: [
        {
          name: 'A', prompt: 'How many churned contacts are there? Reply {"churned": <number>} only.', key: 'churned', truth: 137,
          forecast: { control: 0, empty: 0, gateway: 4, reasoning: 'the finding names the paging flag, which control never sees' },
        },
      ],
      ...patch,
    }),
  );
  return file;
}

function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-trial-test-'));
  fs.mkdirSync(path.join(h, 'cairn'));
  return h;
}

function run(env: Record<string, string | undefined>, ...args: string[]) {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  const r = spawnSync('npx', ['tsx', 'scripts/gateway-trial.ts', ...args], { cwd: REPO, env: e as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('refuses without CAIRN_HOME, and with one inside the repository', () => {
  const h = home();
  const f = trialFile(h);
  const none = run({ CAIRN_HOME: undefined }, f);
  assert.equal(none.status, 2);
  assert.match(none.out, /REFUSED — CAIRN_HOME is not set/);
  const inside = run({ CAIRN_HOME: REPO }, f);
  assert.equal(inside.status, 2);
  assert.match(inside.out, /resolves inside this repository/);
});

test('refuses when execution is enabled for that corpus', () => {
  const h = home();
  const f = trialFile(h);
  const policy = path.join(h, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ [h]: { enabled: true } }));
  const r = run({ CAIRN_HOME: h, CAIRN_POLICY: policy }, f);
  assert.equal(r.status, 2);
  assert.match(r.out, /execution is ENABLED/);
});

test('refuses a scenario file with no per-tool allowlist', () => {
  const h = home();
  const f = trialFile(h, { allowedTools: [] });
  const r = run({ CAIRN_HOME: h, CAIRN_POLICY: path.join(h, 'none.json') }, f);
  assert.equal(r.status, 2);
  assert.match(r.out, /there is no server-wide permission/);
});

test('refuses to run a forecast that is not committed', () => {
  const h = home();
  const f = trialFile(h);
  /* The seal is checked before the bundle, so this holds in CI where dist/ is never built. */
  const r = run({ CAIRN_HOME: h, CAIRN_POLICY: path.join(h, 'none.json') }, f);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /is not in a git repository, so its forecast cannot be sealed|not committed/);
});
