/**
 * The Bash fail-then-recover hook: remembers a failure, asks once when the
 * same program later works, pre-fills both calls verbatim, and is otherwise
 * silent. Driven the way Claude Code drives it, with the JSON it sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK = path.join(process.cwd(), '.claude', 'hooks', 'post-bash.sh');

function run(tmp: string, session: string, command: string, response: Record<string, unknown>): string {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, tool_response: response }),
    env: { ...process.env, TMPDIR: tmp, CAIRN_ARCS: path.join(tmp, 'arcs.jsonl') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'the hook never fails the call');
  return r.stdout;
}

test('a failure is remembered silently; the recovery asks once, pre-filled from the transcript; then quiet', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  assert.equal(run(tmp, 's1', 'sf agent publish --name Demo', { stdout: '', stderr: 'Error: agent user lacks class access', exit_code: 1 }), '', 'a failure alone says nothing');
  assert.equal(run(tmp, 's1', 'ls -la', { stdout: 'x', exit_code: 0 }), '', 'an unrelated success says nothing');
  const out = run(tmp, 's1', 'sf agent publish --name Demo', { stdout: 'Published.', exit_code: 0 });
  const j = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ctx = j.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Fail-then-recover detected on `sf agent`/);
  assert.match(ctx, /agent user lacks class access/, 'the failing output, verbatim');
  assert.match(ctx, /Trap worth banking, or your own slip\?/);
  assert.match(ctx, /cairn_note \{"arc":"arc-[0-9a-f]{8}","title":"","tool":"sf agent","evidence":\[\{"command":"sf agent publish --name Demo"/, 'pre-filled with the failing command');
  assert.match(ctx, /"command":"sf agent publish --name Demo","output":"\(succeeded\)"/, 'and the working one');
  assert.match(ctx, /- my mistake:\s+cairn_note \{"dismiss":"arc-[0-9a-f]{8}","as":"my-mistake"\}/, 'a slip is one answer');
  assert.match(ctx, /- not surprising:\s+cairn_note \{"dismiss":"arc-[0-9a-f]{8}","as":"not-surprising"\}/, 'an expected failure is another');
  const arcs = fs.readFileSync(path.join(tmp, 'arcs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].choice, 'offered', 'the offer is counted, so an unanswered one is not lost');
  assert.equal(arcs[0].key, 'sf agent');
  assert.equal(run(tmp, 's1', 'sf agent publish --name Demo', { stdout: 'Published.', exit_code: 0 }), '', 'once per key per session');
  /* A different session does not inherit the arc... */
  assert.equal(run(tmp, 's2', 'sf agent publish --name Demo', { stdout: 'Published.', exit_code: 0 }), '');
  /* ...but a remembered answer keeps the same arc quiet in a later session. */
  fs.appendFileSync(path.join(tmp, 'arcs.jsonl'), JSON.stringify({ at: new Date().toISOString(), arc: arcs[0].arc, key: 'sf agent', failing: arcs[0].failing, choice: 'my-mistake' }) + '\n');
  assert.equal(run(tmp, 's3', 'sf agent publish --name Demo', { stdout: '', stderr: 'Error: agent user lacks class access', exit_code: 1 }), '');
  assert.equal(run(tmp, 's3', 'sf agent publish --name Demo', { stdout: 'Published.', exit_code: 0 }), '', 'a slip dismissed this week is not offered again');
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'cairn-bash-s3.json'), 'utf8'));
  assert.equal(state.fired[0].muted, 'my-mistake', 'and the session state says why it stayed quiet');
});

test('trivial programs and non-Bash tools never fire, and the arc is keyed on program and subcommand', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  assert.equal(run(tmp, 's3', 'cat /nope', { stderr: 'No such file', exit_code: 1 }), '');
  assert.equal(run(tmp, 's3', 'cat /etc/hostname', { stdout: 'x', exit_code: 0 }), '', 'cat is a slip, never a trap');
  assert.equal(run(tmp, 's3', 'npx sf data query -q "SELECT"', { stderr: 'ERROR', is_error: true }), '', 'wrappers are walked through');
  assert.equal(run(tmp, 's3', 'sf agent list', { stdout: 'ok', exit_code: 0 }), '', 'a different subcommand is a different key');
  assert.match(run(tmp, 's3', 'sf data query -q "SELECT Id FROM Account"', { stdout: 'rows', exit_code: 0 }), /detected on `sf data`/);
  const r = spawnSync('bash', [HOOK], { input: JSON.stringify({ session_id: 's3', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: {} }), env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' });
  assert.equal(r.stdout, '');
});
