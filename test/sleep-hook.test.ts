/**
 * The two automatic modes are the whole point of sleep: a `npm run cairn:sleep`
 * nobody types is a feature that does not exist. --hook (SessionEnd) reads Claude
 * Code's hook JSON on stdin and consolidates the named transcript. --surface
 * (SessionStart) FIRST catches up any transcript a missed SessionEnd never
 * consolidated — the Ctrl-C / crash case, since the transcript is on disk either
 * way — then reports what is waiting. Both MUST exit 0 whatever happens: a hook
 * that throws is a broken session, not a broken hook (cairn-0046).
 *
 * Every test runs against a throwaway HOME, so the catch-up walk sees only the
 * transcripts the test placed under it, never the developer's real history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.join(process.cwd(), 'scripts', 'sleep.ts');

/** A self-contained world: an isolated HOME (for the transcript walk) and a corpus. */
function world(): { home: string; corpus: string; projects: string; drafts: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-hook-'));
  const projects = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  const corpus = path.join(home, 'corpus');
  return { home, corpus, projects, drafts: path.join(corpus, 'drafts') };
}

/** Run the sleep CLI with a stdin payload and an isolated HOME. Never throws on non-zero exit. */
function run(w: { home: string }, args: string[], stdin: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, HOME: w.home },
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '' };
  }
}

/** Write a transcript with one genuine surprise gap (empty result, then a model update). */
function transcript(dir: string, name: string): string {
  const file = path.join(dir, name);
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

const draftCount = (w: { drafts: string }) =>
  fs.existsSync(w.drafts) ? fs.readdirSync(w.drafts).filter((n) => n.endsWith('.json')).length : 0;

test('--hook consolidates the transcript named on stdin into drafts/', () => {
  const w = world();
  const t = transcript(w.projects, 't.jsonl');
  const { status } = run(w, ['--hook', '--home', w.corpus], JSON.stringify({ transcript_path: t, session_id: 'x' }));
  assert.equal(status, 0, 'the hook exits 0');
  assert.equal(draftCount(w), 1, 'the one surprise gap became one draft');
  const drafts = fs.readdirSync(w.drafts).filter((n) => n.endsWith('.json'));
  const draft = JSON.parse(fs.readFileSync(path.join(w.drafts, drafts[0]), 'utf8'));
  assert.equal(draft.tool, 'query_records');
  assert.match(draft.mechanism_or_update, /wrong org/, "the agent's own correction is carried into the draft");
});

test('--surface catches up a transcript a missed SessionEnd never consolidated', () => {
  const w = world();
  /* Prime an ancient watermark, then drop a transcript that no --hook ever saw —
   * exactly what a Ctrl-C'd session leaves behind. */
  fs.mkdirSync(w.drafts, { recursive: true });
  fs.writeFileSync(path.join(w.drafts, '.consolidated'), '1000\n');
  transcript(w.projects, 'crashed.jsonl');
  const { status, stdout } = run(w, ['--surface', '--home', w.corpus], JSON.stringify({ transcript_path: '/some/other/current.jsonl' }));
  assert.equal(status, 0);
  assert.equal(draftCount(w), 1, 'the abandoned transcript was swept up at the next session start');
  assert.match(stdout, /1 consolidated candidate/, 'and reported');
});

test('--surface excludes the current session and, on first run, backfills nothing', () => {
  const w = world();
  /* A machine with existing history: first --surface must not scan it all at a
   * latency-sensitive session start. No watermark yet -> adopt now, harvest none. */
  transcript(w.projects, 'old-history.jsonl');
  const cur = transcript(w.projects, 'current.jsonl');
  const { status, stdout } = run(w, ['--surface', '--home', w.corpus], JSON.stringify({ transcript_path: cur }));
  assert.equal(status, 0);
  assert.equal(draftCount(w), 0, 'first run backfills nothing');
  assert.equal(stdout.trim(), '', 'and says nothing when there is nothing waiting');
  assert.ok(fs.existsSync(path.join(w.drafts, '.consolidated')), 'but it records the baseline watermark');
});

test('--hook then --surface does not re-scan the just-ended session (watermark advances)', () => {
  const w = world();
  const t = transcript(w.projects, 't.jsonl');
  run(w, ['--hook', '--home', w.corpus], JSON.stringify({ transcript_path: t }));
  assert.equal(draftCount(w), 1);
  /* SessionEnd advanced the watermark past this transcript, so SessionStart finds
   * nothing new to do but still reports the one waiting draft. */
  const { stdout } = run(w, ['--surface', '--home', w.corpus], JSON.stringify({ transcript_path: '/some/other.jsonl' }));
  assert.equal(draftCount(w), 1, 'no duplicate work');
  assert.match(stdout, /1 consolidated candidate/);
});

test('--hook never throws on garbage stdin or a missing transcript', () => {
  const w = world();
  assert.equal(run(w, ['--hook', '--home', w.corpus], 'not json at all').status, 0, 'garbage stdin exits 0');
  assert.equal(run(w, ['--hook', '--home', w.corpus], JSON.stringify({ transcript_path: '/no/such/file.jsonl' })).status, 0, 'a missing transcript exits 0');
  assert.equal(draftCount(w), 0, 'and writes nothing');
});
