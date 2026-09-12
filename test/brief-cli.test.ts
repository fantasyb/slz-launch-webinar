/**
 * What reaches `cairn:brief` is what the shell left of it.
 *
 * A crew member briefed a pricing task containing `$99` and got a blank. Not
 * the retriever: every invocation path this repository owns hands argv
 * through untouched -- bin/launch.js spawns tsx without a shell, the bundle is
 * `require`d in-process, and `npm run cairn:brief -- '...'` re-quotes its
 * arguments. The token dies one layer up, in the caller's own double quotes:
 * `"... $99 ..."` is `$9` (an unset positional, empty) followed by `9`, so the
 * program is asked about a `9 SaaS plan`. These pin both halves -- the CLI
 * keeps the token, and the failure mode is exactly the caller's quoting --
 * by reading the query the ledger recorded, which is the query the retriever
 * was given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = process.cwd();
const BRIEF = path.join(REPO, 'bin', 'cairn-brief.js');
const TASK = 'pricing page for a $99 SaaS plan';

/** A private home so the row lands beside nothing that is committed. Seeded with one real finding so the corpus is not empty. */
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-brief-cli-'));
  fs.mkdirSync(path.join(h, 'cairn'));
  const donor = fs.readdirSync(path.join(REPO, 'cairn')).find((f) => f.endsWith('.json'))!;
  fs.copyFileSync(path.join(REPO, 'cairn', donor), path.join(h, 'cairn', donor));
  return h;
}

function recordedQuery(h: string): string {
  const dir = path.join(h, 'data', 'retrievals');
  const rows = fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { source: string; query: string }));
  const row = rows.find((r) => r.source === 'cli:brief');
  assert.ok(row, `no cli:brief row in ${rows.map((r) => r.source).join(', ')}`);
  return row!.query;
}

/* The environment a brief runs in: this home, no eval flag (the ledger row is the evidence). */
function env(h: string): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...process.env, CAIRN_HOME: h };
  delete e.CAIRN_EVAL;
  return e as NodeJS.ProcessEnv;
}

test('a price-like $99 token survives into the query through the launcher (no shell in between)', () => {
  const h = home();
  const r = spawnSync(process.execPath, [BRIEF, '--quiet', TASK], { cwd: REPO, env: env(h), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recordedQuery(h), TASK);
  fs.rmSync(h, { recursive: true, force: true });
});

test('and through npm run, which re-quotes its arguments', () => {
  const h = home();
  const r = spawnSync('npm', ['run', '-s', 'cairn:brief', '--', '--quiet', TASK], { cwd: REPO, env: env(h), encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recordedQuery(h), TASK);
  fs.rmSync(h, { recursive: true, force: true });
});

test('the token is lost only in the caller\'s own double quotes: "$99" reaches the program as "9"', () => {
  const sh = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (sh.status !== 0) return; // no bash to demonstrate the shell's half with
  const h = home();
  /* Written the way a person types it, in double quotes, and run by a shell. */
  const r = spawnSync('bash', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(BRIEF)} --quiet "${TASK}"`], { cwd: REPO, env: env(h), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recordedQuery(h), 'pricing page for a 9 SaaS plan', 'the shell, not the CLI, ate it');
  fs.rmSync(h, { recursive: true, force: true });
});
