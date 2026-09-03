/**
 * The two automatic modes are the whole point of sleep: a `npm run cairn:sleep`
 * nobody types is a feature that does not exist. --hook (SessionEnd) reads Claude
 * Code's hook JSON on stdin, consolidates the named transcript into drafts/, and
 * MUST exit 0 whatever happens — a hook that throws is a broken session, not a
 * broken hook (cairn-0046). --surface (SessionStart) reports what is waiting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.join(process.cwd(), 'scripts', 'sleep.ts');

/** Run the sleep CLI with a stdin payload; returns {status, stdout}. Never throws on a non-zero exit. */
function run(args: string[], stdin: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT, ...args], { input: stdin, encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

/** A tiny transcript with one genuine surprise gap: an empty result then a model update. */
function transcript(dir: string): string {
  const file = path.join(dir, 't.jsonl');
  const line = (message: object) => JSON.stringify({ message });
  fs.writeFileSync(
    file,
    [
      line({ role: 'assistant', content: [{ type: 'text', text: 'I expect the churned contacts.' }, { type: 'tool_use', id: 'a1', name: 'query_records', input: { object: 'Contact' } }] }),
      line({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: '{"records":[]}' }] }),
      line({ role: 'assistant', content: [{ type: 'text', text: 'Zero rows — actually it turns out the MCP bound to the wrong org.' }] }),
    ].join('\n'),
  );
  return file;
}

test('--hook consolidates the transcript named on stdin into drafts/', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  const t = transcript(home);
  const { status } = run(['--hook', '--home', home], JSON.stringify({ transcript_path: t, session_id: 'x' }));
  assert.equal(status, 0, 'the hook exits 0');
  const drafts = fs.readdirSync(path.join(home, 'drafts')).filter((n) => n.endsWith('.json'));
  assert.equal(drafts.length, 1, 'the one surprise gap became one draft');
  const draft = JSON.parse(fs.readFileSync(path.join(home, 'drafts', drafts[0]), 'utf8'));
  assert.equal(draft.tool, 'query_records');
  assert.match(draft.mechanism_or_update, /wrong org/, 'the agent\'s own correction is carried into the draft');
});

test('--surface reports the waiting candidates on stdout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  const t = transcript(home);
  run(['--hook', '--home', home], JSON.stringify({ transcript_path: t }));
  const { status, stdout } = run(['--surface', '--home', home], '{}');
  assert.equal(status, 0);
  assert.match(stdout, /1 consolidated candidate/, 'the count is surfaced');
  assert.match(stdout, /cairn_record/, 'and the way to promote it');
});

test('--surface on an empty corpus says nothing and exits 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  const { status, stdout } = run(['--surface', '--home', home], '{}');
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '', 'no drafts, no noise at session start');
});

test('--hook never throws on garbage stdin or a missing transcript', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  assert.equal(run(['--hook', '--home', home], 'not json at all').status, 0, 'garbage stdin exits 0');
  assert.equal(run(['--hook', '--home', home], JSON.stringify({ transcript_path: '/no/such/file.jsonl' })).status, 0, 'a missing transcript exits 0');
  assert.ok(!fs.existsSync(path.join(home, 'drafts')), 'and writes nothing');
});
